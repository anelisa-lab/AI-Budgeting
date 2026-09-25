"""
Basket comparison — POST /compare/basket (Phase 4).

Replaces the arithmetic the Compare screen used to do in the browser. The
screen sends the product ids on the student's list; this answers "where
should I do this whole shop?" with delivery charged once per order, travel
once per trip, and nothing imputed for a store that doesn't stock an item.
The rules live in app/basket.py (pure, tests/test_basket.py).

Offers are looked up by PRODUCT ID. The browser used to find them by
re-searching each product's name through GET /search, which only worked as
long as the natural-language parser happened not to read anything in a
product name as a filter.
"""

from fastapi import APIRouter, Depends, HTTPException

from app.basket import BasketLine, BasketOffer, StoreInfo, compare_basket
from app.database import get_connection
from app.dependencies import get_current_user_id
from app.geo import distance_between, fetch_user_location
from app.schemas import CompareBasketRequest, CompareBasketResponse
from app.true_cost import load_store_charges, money

router = APIRouter(prefix="/compare", tags=["compare"])

_OFFERS_SQL = """
    SELECT o.id AS offer_id, o.product_id, o.store_id, o.price, o.shipping_cost,
           o.availability_status, o.price_source, o.price_verified_at, o.product_url,
           p.name AS product_name, p.size,
           s.name AS store_name, s.store_type, s.latitude, s.longitude,
           s.delivery_available, s.collection_available
    FROM product_offers o
    JOIN products p ON p.id = o.product_id
    JOIN stores s ON s.id = o.store_id
    WHERE o.product_id = ANY(%s)
    ORDER BY o.product_id, o.price, o.id
"""


@router.post("/basket", response_model=CompareBasketResponse)
def compare_basket_endpoint(
    payload: CompareBasketRequest, user_id: int = Depends(get_current_user_id)
):
    product_ids = sorted({item.product_id for item in payload.items})

    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(_OFFERS_SQL, (product_ids,))
            rows = cur.fetchall()
            if not rows:
                raise HTTPException(
                    status_code=404,
                    detail="None of the items on this list are listed by any store any more.",
                )
            charges_by_store = load_store_charges(cur, {r["store_id"] for r in rows})
            location = fetch_user_location(cur, user_id) if payload.use_my_location else None
    finally:
        conn.close()

    stores, offers_by_product = {}, {}
    for r in rows:
        if r["store_id"] not in stores:
            online = r["store_type"] == "online"
            stores[r["store_id"]] = StoreInfo(
                store_id=r["store_id"], store_name=r["store_name"], store_type=r["store_type"],
                delivery_available=r["delivery_available"],
                collection_available=r["collection_available"],
                distance_km=None if online else distance_between(
                    location, (r["latitude"], r["longitude"])),
            )
        offers_by_product.setdefault(r["product_id"], []).append(BasketOffer(
            offer_id=r["offer_id"], product_id=r["product_id"], store_id=r["store_id"],
            price=money(r["price"]), product_name=r["product_name"], size=r["size"],
            shipping_cost=money(r["shipping_cost"] or 0),
            availability_status=r["availability_status"],
            price_source=r["price_source"] or "seed_estimate",
            price_verified_at=r["price_verified_at"], product_url=r["product_url"],
        ))

    result = compare_basket(
        [BasketLine(item.product_id, item.qty) for item in payload.items],
        offers_by_product, stores, charges_by_store, payload.fulfilment,
    )
    # Collection travel can only be costed when we know where the student is.
    result["location_known"] = location is not None
    return CompareBasketResponse(**result)
