from typing import Optional
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query

from app.database import get_connection
from app.dependencies import get_current_user_id
from app.query_parser import parse_query
from app.schemas import ParsedQueryOut, SearchResponse, SearchResultItem

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
#   sort              'price_asc' (default) | 'price_desc' | 'newest' | 'rating_desc'
#                     (when omitted, a hint in q like "cheapest" / "best rated" is used)
#   limit / offset     pagination (default 20 / 0, max limit 100); or page (1-based)
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
#
# Phase 3 (edge cases + pagination):
#   - invalid filter combos are rejected with 400 and a readable `detail`
#     instead of silently returning nothing: min_price > max_price, an
#     unknown availability value, an unknown sort key.
#   - blank strings (e.g. `?brand=` from an empty form field) are ignored
#     rather than matching nothing.
#   - `page` (1-based) is accepted as an alternative to `offset`.
#   - the response adds page, total_pages, has_more, next_offset and a
#     `message` explaining an empty result. results/count/limit/offset are
#     unchanged, so existing callers keep working.
#
# Natural-language q (the Phase 2 "keyword + natural-language" requirement):
#   q is run through app/query_parser.py — the same rule-based parser the
#   recommender uses. "black sneakers under R500 size 9" becomes
#   colour=black, size=9, max_price=500, keywords=["sneakers"], so words like
#   "under" and "R500" are no longer required to appear in a product name
#   (which made any such query return nothing). An explicit query parameter
#   always wins over what the parser found, and the parser's reading is
#   returned as `parsed` so the frontend can show "searching for: ...".
#   The parsed category is not applied as a filter — the keywords already
#   match against category, and a wrong guess would hide real results.

AVAILABILITY_VALUES = ("available", "out_of_stock", "unknown", "any")
SORT_MAP = {
    "price_asc": "o.total_cost ASC, o.id ASC",
    "price_desc": "o.total_cost DESC, o.id ASC",
    "newest": "o.last_checked_at DESC NULLS LAST, o.id ASC",
    "rating_desc": "o.rating DESC NULLS LAST, o.total_cost ASC, o.id ASC",
}


def _clean(value: Optional[str]) -> Optional[str]:
    """Treat '' and whitespace-only params as 'not supplied'."""
    if value is None:
        return None
    value = value.strip()
    return value or None


def _no_results_message(active_filters: list) -> str:
    if not active_filters:
        return "No products are in the catalogue yet."
    return (
        "No products matched " + ", ".join(active_filters) + ". "
        "Try fewer keywords, a higher max price, or availability=any."
    )


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
    sort: Optional[str] = None,
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    page: Optional[int] = Query(default=None, ge=1),
    user_id: int = Depends(get_current_user_id),
):
    q, category, brand, colour, size, store = (
        _clean(q), _clean(category), _clean(brand), _clean(colour), _clean(size), _clean(store)
    )
    availability = (_clean(availability) or "available").lower()

    # --- natural-language q -> constraints (explicit params win) -----------
    parsed = parse_query(q) if q else None
    keywords = parsed.keywords if parsed else []
    if parsed:
        colour = colour or parsed.colour
        size = size or parsed.size
        if min_price is None and parsed.min_price is not None:
            min_price = parsed.min_price
        if max_price is None and parsed.max_price is not None:
            max_price = parsed.max_price
        essential_only = essential_only or parsed.essential_only
        if max_shipping_cost is None and parsed.free_delivery_only:
            max_shipping_cost = Decimal("0")

    sort = _clean(sort)
    if sort is None:
        sort = parsed.sort_hint if parsed and parsed.sort_hint in SORT_MAP else "price_asc"
    sort = sort.lower()

    # --- reject filter combinations that can never match -------------------
    if min_price is not None and max_price is not None and min_price > max_price:
        raise HTTPException(
            status_code=400,
            detail=f"min_price (R{min_price}) cannot be greater than max_price (R{max_price})",
        )
    if availability not in AVAILABILITY_VALUES:
        raise HTTPException(
            status_code=400,
            detail=f"availability must be one of: {', '.join(AVAILABILITY_VALUES)}",
        )
    if sort not in SORT_MAP:
        raise HTTPException(
            status_code=400,
            detail=f"sort must be one of: {', '.join(SORT_MAP)}",
        )
    if page is not None:
        offset = (page - 1) * limit

    conditions = []
    params: list = []
    active_filters: list = []

    for token in keywords:
        conditions.append(
            "(p.name ILIKE %s OR p.brand ILIKE %s OR p.category ILIKE %s OR p.subcategory ILIKE %s)"
        )
        like = f"%{token}%"
        params.extend([like, like, like, like])
    if keywords:
        active_filters.append("'" + " ".join(keywords) + "'")

    if category:
        conditions.append("p.category ILIKE %s")
        params.append(category)
        active_filters.append(f"category {category}")
    if brand:
        conditions.append("p.brand ILIKE %s")
        params.append(brand)
        active_filters.append(f"brand {brand}")
    if colour:
        conditions.append("p.colour ILIKE %s")
        params.append(colour)
        active_filters.append(f"colour {colour}")
    if size:
        conditions.append("p.size ILIKE %s")
        params.append(size)
        active_filters.append(f"size {size}")
    if store:
        conditions.append("s.name ILIKE %s")
        params.append(f"%{store}%")
        active_filters.append(f"store {store}")
    if min_price is not None:
        conditions.append("o.total_cost >= %s")
        params.append(min_price)
        active_filters.append(f"min R{min_price}")
    if max_price is not None:
        conditions.append("o.total_cost <= %s")
        params.append(max_price)
        active_filters.append(f"max R{max_price}")
    if max_shipping_cost is not None:
        conditions.append("o.shipping_cost <= %s")
        params.append(max_shipping_cost)
        active_filters.append(f"shipping up to R{max_shipping_cost}")
    if availability != "any":
        conditions.append("o.availability_status = %s")
        params.append(availability)
    if essential_only:
        conditions.append("p.is_essential = TRUE")
        active_filters.append("essentials only")

    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    order_by = SORT_MAP[sort]

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

            rows = []
            if offset < count:
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
    finally:
        conn.close()

    total_pages = (count + limit - 1) // limit
    has_more = offset + len(rows) < count

    message = None
    if count == 0:
        message = _no_results_message(active_filters)
    elif not rows:
        message = f"Page is past the end of the results — there are only {total_pages} page(s)."

    return SearchResponse(
        results=[SearchResultItem(**row) for row in rows],
        count=count,
        limit=limit,
        offset=offset,
        page=offset // limit + 1,
        total_pages=total_pages,
        has_more=has_more,
        next_offset=offset + limit if has_more else None,
        message=message,
        parsed=ParsedQueryOut(**parsed.to_constraints()) if parsed else None,
    )
