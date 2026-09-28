"""
Live store search — GET /live-search?query=bread

Searches the stores switched on in LIVE_PRICE_STORES (app/scrapers — only
Checkers Sixty60 for now) and returns name, price, image and link for each
product. Only rows whose items.store belongs to a switched-on store are
returned (filtered in SQL), so another store's old rows never show.

Answers come from the database when the same query was searched within
LIVE_SEARCH_TTL_HOURS (default 6), so Checkers is asked at most once per
query per six hours however many students search. Cache rules:
app/live_search.py.

Separate from GET /search, which searches the curated catalogue
(products / product_offers) with filters and the recommender's fields.

Logged-in students only, like every other route: a cache miss makes an
outbound request to the store.

Response:
    {
      "query": "bread",
      "results": [{"id", "name", "price", "last_known_price", "last_priced_at",
                   "image_url", "product_url", "store", "brand", "category",
                   "on_promotion", "in_stock", "last_updated"}],
      "count": 40,
      "stores": [{"store": "checkers", "name": "Checkers", "source": "cache",
                  "fetched_at": "...", "count": 40}],
      "message": null       # set when a store couldn't be reached or nothing matched
    }
price is null — never 0 — when the store has no price right now (out of
stock); last_known_price is then the last real price seen, if any. Buyable
items (in stock, priced) come first.

source: "cache" (from the DB, fresh), "live" (just fetched), "stale" (the
store couldn't be reached, so an older saved answer), "unavailable" (no
answer at all).
"""

from fastapi import APIRouter, Depends, Query

from app import live_search
from app.database import get_connection
from app.dependencies import get_current_user_id
from app.schemas import LiveSearchResponse, LiveSearchStoreStatus

router = APIRouter(tags=["live search"])


@router.get("/live-search", response_model=LiveSearchResponse)
@router.get("/api/search", response_model=LiveSearchResponse,
            include_in_schema=False)
def live_store_search(
    query: str = Query(..., min_length=2, max_length=100,
                       description="What to search for, e.g. 'bread'"),
    user_id: int = Depends(get_current_user_id),
):
    conn = get_connection()
    try:
        per_store = live_search.search(conn, query)
    finally:
        conn.close()

    results = [item for store in per_store for item in store.items]
    return LiveSearchResponse(
        query=live_search.normalise_query(query),
        results=results,
        count=len(results),
        stores=[LiveSearchStoreStatus(store=s.store, name=s.name, source=s.source,
                                      fetched_at=s.fetched_at, count=len(s.items))
                for s in per_store],
        message=_message(per_store, results),
    )


def _message(per_store, results):
    if not per_store:
        return "Live prices are switched off (LIVE_PRICE_STORES is empty)."
    down = [s.store for s in per_store if s.source in ("stale", "unavailable")]
    if not results:
        if down:
            return "We couldn't reach the store right now and have no saved results. Try again shortly."
        return "No products matched your search."
    if down:
        return "Some prices may be out of date: we couldn't reach the store just now."
    return None
