"""
True-cost endpoints — Member 6.

    POST /true-cost            price up to 50 offers at once and say which is
                               genuinely cheapest
    GET  /true-cost/{offer_id} one offer, itemised

The maths lives in app/true_cost.py (pure, unit-tested). This file only does
SQL and shapes the response.

Comparing several offers in one call is the point: "which of these three
stores is actually cheapest for me" cannot be answered one offer at a time,
because the answer depends on delivery thresholds and how far each store is.
"""

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.database import get_connection
from app.dependencies import get_current_user_id
from app.geo import distance_between, fetch_user_location
from app.schemas import (
    ChargeLineOut,
    TrueCostOut,
    TrueCostRequest,
    TrueCostResponse,
)
from app.true_cost import Offer, load_store_charges, money, store_true_cost

router = APIRouter(prefix="/true-cost", tags=["true cost"])

_OFFER_QUERY = """
    SELECT o.id AS offer_id, o.price, o.shipping_cost, o.currency,
           p.name AS product_name,
           s.id AS store_id, s.name AS store_name, s.store_type,
           s.latitude AS store_latitude, s.longitude AS store_longitude,
           s.delivery_available, s.collection_available
    FROM product_offers o
    JOIN products p ON p.id = o.product_id
    JOIN stores s ON s.id = o.store_id
    WHERE o.id = ANY(%s)
"""


def _price_rows(
    rows: List[dict],
    charges_by_store: dict,
    *,
    quantity: int,
    fulfilment: str,
    user_location: Optional[tuple],
) -> List[TrueCostOut]:
    results: List[TrueCostOut] = []

    for row in rows:
        distance_km = None
        if row["store_type"] != "online":
            distance_km = distance_between(
                user_location, (row["store_latitude"], row["store_longitude"])
            )

        breakdown = store_true_cost(
            Offer.from_row(row),
            charges_by_store.get(row["store_id"], []),
            quantity=quantity,
            fulfilment=fulfilment,
            distance_km=distance_km,
        )

        payload = breakdown.as_dict()
        payload["charges"] = [ChargeLineOut(**c) for c in payload["charges"]]
        results.append(
            TrueCostOut(
                **payload,
                product_name=row["product_name"],
                store_name=row["store_name"],
            )
        )

    return results


@router.post("", response_model=TrueCostResponse)
def compare_true_cost(
    payload: TrueCostRequest, user_id: int = Depends(get_current_user_id)
):
    """
    True cost for a set of offers, cheapest flagged.

    `fulfilment='collection'` drops delivery fees and adds an estimated
    travel cost instead — which is how a student finds out that the R60
    they save on delivery costs R48 in taxi fare.
    """
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(_OFFER_QUERY, (payload.offer_ids,))
            rows = cur.fetchall()
            if not rows:
                raise HTTPException(status_code=404, detail="No offers found for those ids")

            charges_by_store = load_store_charges(cur, [r["store_id"] for r in rows])
            user_location = (
                fetch_user_location(cur, user_id) if payload.use_my_location else None
            )
    finally:
        conn.close()

    results = _price_rows(
        rows,
        charges_by_store,
        quantity=payload.quantity,
        fulfilment=payload.fulfilment,
        user_location=user_location,
    )

    # Keep unfulfillable offers visible so the UI can explain why they were
    # rejected, but never let one win the comparison. This mirrors
    # app.true_cost.cheapest(): the requested fulfilment is part of the
    # definition of a comparable price.
    results.sort(key=lambda r: (not r.fulfilment_available, r.true_cost, r.offer_id))
    eligible = [r for r in results if r.fulfilment_available]

    saving = (
        money(eligible[-1].true_cost - eligible[0].true_cost)
        if len(eligible) > 1 else money(0)
    )

    return TrueCostResponse(
        results=results,
        cheapest_offer_id=eligible[0].offer_id if eligible else None,
        saving_vs_dearest=saving,
    )


@router.get("/{offer_id}", response_model=TrueCostOut)
def true_cost_for_offer(
    offer_id: int,
    quantity: int = Query(default=1, ge=1, le=99),
    fulfilment: str = Query(default="delivery", pattern="^(delivery|collection)$"),
    use_my_location: bool = True,
    user_id: int = Depends(get_current_user_id),
):
    """Itemised true cost for one offer — what the product page shows."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(_OFFER_QUERY, ([offer_id],))
            rows = cur.fetchall()
            if not rows:
                raise HTTPException(status_code=404, detail="Offer not found")

            charges_by_store = load_store_charges(cur, [rows[0]["store_id"]])
            user_location = fetch_user_location(cur, user_id) if use_my_location else None
    finally:
        conn.close()

    return _price_rows(
        rows,
        charges_by_store,
        quantity=quantity,
        fulfilment=fulfilment,
        user_location=user_location,
    )[0]
