"""Authenticated recommendation endpoints backed by the rule-based ranker."""

from decimal import Decimal
from time import perf_counter
from typing import Optional

from fastapi import APIRouter, Depends, Query
from psycopg2.extras import Json

from app.budget_split import build_split
from app.database import get_connection
from app.dependencies import get_current_user_id
from app.geo import distance_between, fetch_user_location
from app.query_parser import ParsedQuery, parse_query
from app.recommender import Candidate, UserContext, recommend
from app.schemas import (
    BudgetContextOut, ChargeLineOut, ParsedQueryOut, RecommendationRequest,
    RecommendationResponse, RecommendedOffer, TrueCostOut,
)
from app.true_cost import load_store_charges, store_true_cost

router = APIRouter(prefix="/recommendations", tags=["recommendations"])
MODEL_NAME = "rule-based-v1"

_CANDIDATE_SELECT = """
    SELECT o.id AS offer_id, p.id AS product_id, p.name AS product_name,
           p.brand, p.category, p.subcategory, p.colour, p.size, p.is_essential,
           s.id AS store_id, s.name AS store_name, s.store_type,
           s.latitude AS store_latitude, s.longitude AS store_longitude,
           o.price, o.shipping_cost, o.total_cost, o.currency,
           o.availability_status, o.rating, o.rating_count,
           o.last_checked_at AS last_updated, o.product_url
    FROM product_offers o
    JOIN products p ON p.id = o.product_id
    JOIN stores s ON s.id = o.store_id
"""


def _candidate_sql(payload: RecommendationRequest, parsed: ParsedQuery):
    conditions = ["o.availability_status = 'available'"]
    params = []
    category = payload.category if payload.category is not None else parsed.category
    if category:
        conditions.append("p.category ILIKE %s")
        params.append(category)
    if parsed.subcategory:
        conditions.append("(p.subcategory ILIKE %s OR p.subcategory IS NULL)")
        params.append(parsed.subcategory)
    if parsed.colour:
        conditions.append("p.colour ILIKE %s")
        params.append(parsed.colour)
    if parsed.size:
        conditions.append("p.size ILIKE %s")
        params.append(parsed.size)
    max_price = payload.max_price if payload.max_price is not None else parsed.max_price
    if max_price is not None:
        conditions.append("o.total_cost <= %s")
        params.append(max_price)
    if parsed.min_price is not None:
        conditions.append("o.total_cost >= %s")
        params.append(parsed.min_price)
    if parsed.essential_only:
        conditions.append("p.is_essential = TRUE")
    if parsed.free_delivery_only:
        conditions.append("o.shipping_cost = 0")
    params.append(payload.candidate_pool)
    return f"{_CANDIDATE_SELECT} WHERE {' AND '.join(conditions)} ORDER BY o.total_cost ASC LIMIT %s", params


def _to_out(item):
    candidate, breakdown = item.candidate, item.breakdown
    payload = breakdown.as_dict()
    payload["charges"] = [ChargeLineOut(**charge) for charge in payload["charges"]]
    cost = TrueCostOut(**payload, product_name=candidate.product_name, store_name=candidate.store_name)
    return RecommendedOffer(
        rank=item.rank, offer_id=candidate.offer_id, product_id=candidate.product_id,
        product_name=candidate.product_name, brand=candidate.brand, category=candidate.category,
        subcategory=candidate.subcategory, colour=candidate.colour, size=candidate.size,
        is_essential=candidate.is_essential, store_id=candidate.store_id, store_name=candidate.store_name,
        store_type=candidate.store_type, product_url=candidate.product_url, rating=candidate.rating,
        rating_count=candidate.rating_count, price=candidate.price, true_cost=item.true_cost,
        currency=candidate.currency, distance_km=item.distance_km, score=item.score,
        component_scores=item.components, meets_budget=item.meets_budget,
        meets_preferences=item.meets_preferences, explanation=item.explanation, cost_breakdown=cost,
    )


@router.post("", response_model=RecommendationResponse)
def get_recommendations(payload: RecommendationRequest, user_id: int = Depends(get_current_user_id)):
    started = perf_counter()
    parsed = parse_query(payload.query)
    if payload.category is not None:
        parsed.category, parsed.subcategory = payload.category, None
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT * FROM budgets WHERE user_id = %s AND status = 'active'", (user_id,))
            budget = cur.fetchone()
            split = None
            if budget:
                cur.execute(
                    """SELECT transaction_date::date AS day, SUM(amount) AS total
                       FROM transactions WHERE budget_id = %s AND transaction_status <> 'voided'
                       GROUP BY 1""",
                    (budget["id"],),
                )
                split = build_split(
                    budget,
                    spent_by_date={row["day"]: Decimal(row["total"]) for row in cur.fetchall()},
                )

            cur.execute(
                """SELECT preferred_categories, preferred_stores, preferred_brands,
                          preferred_colours, preferred_sizes, max_distance_km,
                          require_available, essential_only
                   FROM preferences WHERE user_id = %s""",
                (user_id,),
            )
            prefs = cur.fetchone() or {}
            location = fetch_user_location(cur, user_id)
            sql, params = _candidate_sql(payload, parsed)
            cur.execute(sql, params)
            rows = cur.fetchall()
            candidates = [Candidate.from_row(row) for row in rows]
            charges = load_store_charges(cur, [row.get("store_id") for row in rows])
            fulfilment = "collection" if parsed.prefer_collection else payload.fulfilment
            context = UserContext(
                remaining_amount=budget["remaining_amount"] if budget else None,
                daily_limit=split.remaining_today if split else None,
                budget_mode=split.mode if split else "normal",
                preferred_categories=prefs.get("preferred_categories") or (),
                preferred_stores=prefs.get("preferred_stores") or (),
                preferred_brands=prefs.get("preferred_brands") or (),
                preferred_colours=prefs.get("preferred_colours") or (),
                preferred_sizes=prefs.get("preferred_sizes") or (),
                max_distance_km=float(prefs["max_distance_km"]) if prefs.get("max_distance_km") is not None else None,
                require_available=prefs.get("require_available", True),
                essential_only=prefs.get("essential_only", False),
                location=location,
                currency=budget["currency"] if budget else "ZAR",
            )

            def price(candidate, _context):
                distance = None
                if candidate.store_type != "online":
                    distance = distance_between(
                        location, (candidate.store_latitude, candidate.store_longitude)
                    )
                return store_true_cost(
                    candidate.to_offer(), charges.get(candidate.store_id, []),
                    fulfilment=fulfilment, distance_km=distance,
                )

            ranked = recommend(
                candidates, context, parsed, pricer=price, limit=payload.limit,
                include_unaffordable=payload.include_unaffordable,
            )
            elapsed_ms = int((perf_counter() - started) * 1000)
            search_id = None
            query_text = payload.query or payload.category
            if query_text:
                cur.execute(
                    """INSERT INTO shopping_searches
                       (user_id, budget_id, query_text, budget_limit, parsed_constraints, status, response_time_ms)
                       VALUES (%s, %s, %s, %s, %s, 'completed', %s) RETURNING id""",
                    (user_id, budget["id"] if budget else None, query_text,
                     payload.max_price or parsed.max_price, Json(parsed.to_constraints()), elapsed_ms),
                )
                search_id = cur.fetchone()["id"]
            cur.execute(
                """INSERT INTO recommendation_runs
                   (user_id, budget_id, search_id, model_name, response_time_ms, source_count)
                   VALUES (%s, %s, %s, %s, %s, %s) RETURNING id""",
                (user_id, budget["id"] if budget else None, search_id, MODEL_NAME, elapsed_ms, len(candidates)),
            )
            run_id = cur.fetchone()["id"]
            if ranked:
                cur.executemany(
                    """INSERT INTO recommendation_items
                       (recommendation_run_id, offer_id, rank, score, total_cost_snapshot,
                        meets_budget, meets_preferences, explanation)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                       ON CONFLICT (recommendation_run_id, offer_id) DO NOTHING""",
                    [(run_id, item.candidate.offer_id, item.rank, item.score, item.true_cost,
                      item.meets_budget, item.meets_preferences, item.explanation) for item in ranked],
                )
    finally:
        conn.close()

    budget_context = BudgetContextOut(
        budget_id=budget["id"] if budget else None,
        remaining_amount=budget["remaining_amount"] if budget else None,
        daily_limit=split.daily_limit if split else None,
        days_remaining=split.days_remaining if split else None,
        mode=split.mode if split else "normal",
        message=split.message if split else "No active budget — ranking on price and fit only.",
    )
    message = None
    if not candidates:
        message = "Nothing in the catalogue matched that search. Try fewer words or a higher price."
    elif not ranked:
        message = "Everything that matched was filtered out. Try a wider search or a higher budget."
    return RecommendationResponse(
        run_id=run_id, search_id=search_id, query=payload.query,
        parsed=ParsedQueryOut(**parsed.to_constraints()), budget=budget_context,
        results=[_to_out(item) for item in ranked], count=len(ranked),
        candidates_considered=len(candidates), response_time_ms=elapsed_ms, message=message,
    )


@router.get("/history")
def recommendation_history(limit: int = Query(default=10, ge=1, le=50),
                           user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT r.id, r.budget_id, r.search_id, r.model_name,
                          r.response_time_ms, r.source_count, r.created_at,
                          s.query_text, s.parsed_constraints
                   FROM recommendation_runs r
                   LEFT JOIN shopping_searches s ON s.id = r.search_id
                   WHERE r.user_id = %s ORDER BY r.created_at DESC LIMIT %s""",
                (user_id, limit),
            )
            runs = cur.fetchall()
            if not runs:
                return {"runs": []}
            cur.execute(
                """SELECT i.recommendation_run_id, i.offer_id, i.rank, i.score,
                          i.total_cost_snapshot, i.meets_budget, i.meets_preferences,
                          i.explanation, p.name AS product_name, st.name AS store_name
                   FROM recommendation_items i
                   JOIN product_offers o ON o.id = i.offer_id
                   JOIN products p ON p.id = o.product_id
                   JOIN stores st ON st.id = o.store_id
                   WHERE i.recommendation_run_id = ANY(%s)
                   ORDER BY i.recommendation_run_id, i.rank""",
                ([run["id"] for run in runs],),
            )
            items = {}
            for row in cur.fetchall():
                items.setdefault(row["recommendation_run_id"], []).append(row)
            return {"runs": [{**run, "items": items.get(run["id"], [])} for run in runs]}
    finally:
        conn.close()