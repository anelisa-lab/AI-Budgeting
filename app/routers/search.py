from typing import Optional
from decimal import Decimal

from fastapi import APIRouter, Depends, Query

from app.database import get_connection
from app.dependencies import get_current_user_id
from app.schemas import SearchResponse, SearchResultItem

router = APIRouter(prefix="/search", tags=["search"])

# Search API contract (Member 4)
# -------------------------------
# GET /search
# Query params:
#   q                 free-text keywords, matched against product name/brand/
#                     category (keyword parsing: split on whitespace, every
#                     token must appear somewhere in name/brand/category —
#                     chosen over NLP parsing to keep Phase 1 scope small)
#   category          exact-ish match (case-insensitive) on products.category
#   brand             case-insensitive match on products.brand
#   colour            case-insensitive match on products.colour
#   size              case-insensitive match on products.size
#   store             case-insensitive match on stores.name
#   min_price/max_price   bounds on product_offers.total_cost (price + shipping)
#   max_shipping_cost bound on product_offers.shipping_cost
#   availability      'available' | 'out_of_stock' | 'unknown' | 'any' (default 'available')
#   essential_only    only return products flagged is_essential
#   sort              'price_asc' (default) | 'price_desc' | 'newest'
#   limit / offset     pagination (default 20 / 0, max limit 100)
# Response shape: { results: [...], count, limit, offset }
# count is the total number of matches (ignoring limit/offset), so the
# frontend can paginate.
#
# Phase 2 addition (for Member 5's recommender — see app/recommender.py):
# each result now also carries subcategory, store_latitude/store_longitude,
# rating, rating_count and last_updated (product_offers.last_checked_at,
# i.e. how fresh the price is). The recommender scores on all five, and the
# frontend can show the rating and a "price checked X hours ago" label.
# `subcategory`, `rating` and `rating_count` were added to the schema in
# sql/002_phase2_recommender.sql — run that migration if your dev DB predates it.


@router.get("", response_model=SearchResponse)
def search_offers(
    q: Optional[str] = None,
    category: Optional[str] = None,
    brand: Optional[str] = None,
    colour: Optional[str] = None,
    size: Optional[str] = None,
    store: Optional[str] = None,
    min_price: Optional[Decimal] = Query(default=None, ge=0),
    max_price: Optional[Decimal] = Query(default=None, ge=0),
    max_shipping_cost: Optional[Decimal] = Query(default=None, ge=0),
    availability: str = "available",
    essential_only: bool = False,
    sort: str = "price_asc",
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user_id: int = Depends(get_current_user_id),
):
    conditions = []
    params: list = []

    if q:
        for token in q.split():
            conditions.append(
                "(p.name ILIKE %s OR p.brand ILIKE %s OR p.category ILIKE %s)"
            )
            like = f"%{token}%"
            params.extend([like, like, like])

    if category:
        conditions.append("p.category ILIKE %s")
        params.append(category)
    if brand:
        conditions.append("p.brand ILIKE %s")
        params.append(brand)
    if colour:
        conditions.append("p.colour ILIKE %s")
        params.append(colour)
    if size:
        conditions.append("p.size ILIKE %s")
        params.append(size)
    if store:
        conditions.append("s.name ILIKE %s")
        params.append(f"%{store}%")
    if min_price is not None:
        conditions.append("o.total_cost >= %s")
        params.append(min_price)
    if max_price is not None:
        conditions.append("o.total_cost <= %s")
        params.append(max_price)
    if max_shipping_cost is not None:
        conditions.append("o.shipping_cost <= %s")
        params.append(max_shipping_cost)
    if availability != "any":
        conditions.append("o.availability_status = %s")
        params.append(availability)
    if essential_only:
        conditions.append("p.is_essential = TRUE")

    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    sort_map = {
        "price_asc": "o.total_cost ASC",
        "price_desc": "o.total_cost DESC",
        "newest": "o.last_checked_at DESC",
    }
    order_by = sort_map.get(sort, sort_map["price_asc"])

    base_from = """
        FROM product_offers o
        JOIN products p ON p.id = o.product_id
        JOIN stores s ON s.id = o.store_id
        {where_clause}
    """.format(where_clause=where_clause)

    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(f"SELECT COUNT(*) AS count {base_from}", params)
            count = cur.fetchone()["count"]

            cur.execute(
                f"""SELECT
                        o.id AS offer_id, p.id AS product_id, p.name AS product_name,
                        p.brand, p.category, p.subcategory, p.colour, p.size, p.is_essential,
                        s.id AS store_id, s.name AS store_name, s.store_type,
                        s.latitude AS store_latitude, s.longitude AS store_longitude,
                        o.price, o.shipping_cost, o.total_cost, o.currency,
                        o.availability_status, o.rating, o.rating_count,
                        o.last_checked_at AS last_updated, o.product_url
                    {base_from}
                    ORDER BY {order_by}
                    LIMIT %s OFFSET %s""",
                params + [limit, offset],
            )
            rows = cur.fetchall()
        return SearchResponse(
            results=[SearchResultItem(**row) for row in rows],
            count=count,
            limit=limit,
            offset=offset,
        )
    finally:
        conn.close()
