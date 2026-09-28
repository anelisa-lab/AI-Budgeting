"""
Cached live store search — the logic behind GET /api/search.

For each active store (app/scrapers, LIVE_PRICE_STORES), and only ever
returning items whose items.store is that store's name, so rows left in the
database by a switched-off store are never shown:

  searched within LIVE_SEARCH_TTL_HOURS (default 6)  -> answer from the DB   ("cache")
  otherwise                                          -> ask the store, upsert
                                                        into items, remember
                                                        the result order     ("live")
  store fails / returns nothing, older answer exists -> the older answer    ("stale")
  store fails / returns nothing, no older answer     -> no results          ("unavailable")

Empty answers are not cached: a scraper returns [] both for "no matches"
and for "blocked / site down", and caching a failure would hide results
for hours. The cache itself is keyed on (store, query) (sql/007), so each
store expires and refreshes on its own schedule.

FAILURE ISOLATION — every store that needs a live fetch (a cache miss or a
stale entry) is asked at the same time, each on its own thread, and each is
given at most LIVE_SEARCH_STORE_TIMEOUT_SECONDS (default 12s) before we stop
waiting on it for this request. A store that raises, times out, or comes
back empty never affects another store's results — see _fetch_many(). The
network calls run in threads; every database write (upsert_items,
_remember) happens afterwards, back on this function's own thread, since a
single psycopg2 connection isn't safe to use from more than one thread at
once.

Tables: sql/006_live_items.sql, sql/007_live_search_cache.sql.
"""

from __future__ import annotations

import logging
import os
import re
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, List, Optional

from app.live_items import upsert_items
from app.scrapers import active_stores, search_store, store_name

log = logging.getLogger(__name__)

DEFAULT_TTL_HOURS = 6.0
DEFAULT_STORE_TIMEOUT_SECONDS = 12.0


def cache_ttl() -> timedelta:
    try:
        hours = float(os.getenv("LIVE_SEARCH_TTL_HOURS", DEFAULT_TTL_HOURS))
    except ValueError:
        hours = DEFAULT_TTL_HOURS
    return timedelta(hours=max(hours, 0))


def store_timeout() -> float:
    """How long a single store's live fetch may run before we stop waiting on
    it for this request (seconds). See the module docstring."""
    try:
        seconds = float(os.getenv("LIVE_SEARCH_STORE_TIMEOUT_SECONDS", DEFAULT_STORE_TIMEOUT_SECONDS))
    except ValueError:
        seconds = DEFAULT_STORE_TIMEOUT_SECONDS
    return max(seconds, 0.1)


def normalise_query(query: str) -> str:
    return re.sub(r"\s+", " ", (query or "").strip().lower())


@dataclass
class StoreResult:
    store: str                          # key, e.g. "checkers"
    source: str                         # cache | live | stale | unavailable
    fetched_at: Optional[datetime]
    items: List[dict] = field(default_factory=list)

    @property
    def name(self) -> str:              # items.store value, e.g. "Checkers"
        return store_name(self.store)


def search(conn, query: str,
           scrape: Callable[[str, str], List[dict]] = search_store,
           stores: Optional[List[str]] = None) -> List[StoreResult]:
    """
    Results per store, cache first. Stores needing a live fetch (no fresh
    cache entry) are all asked AT THE SAME TIME — see _fetch_many() — so one
    slow or blocked store cannot delay the others. `scrape(store, query)` is
    injectable for tests.
    """
    q = normalise_query(query)
    stores = active_stores() if stores is None else stores
    if not stores:
        return []

    cached = {store: _cached(conn, store, q) for store in stores}
    to_fetch = [store for store in stores if not (cached[store] and _is_fresh(cached[store][0]))]
    fetched = _fetch_many(scrape, to_fetch, q, store_timeout()) if to_fetch else {}

    out = []
    for store in stores:
        if store not in to_fetch:
            searched_at, items = cached[store]
            out.append(StoreResult(store, "cache", searched_at, items))
            continue

        products = _own_rows(store, fetched.get(store) or [])
        if products:
            item_ids = upsert_items(conn, products, commit=False)
            searched_at = _remember(conn, store, q, item_ids)
            conn.commit()
            out.append(StoreResult(store, "live", searched_at, _items_for(conn, store, q)))
        elif cached[store]:
            out.append(StoreResult(store, "stale", cached[store][0], cached[store][1]))
        else:
            out.append(StoreResult(store, "unavailable", None, []))
    return out


def _fetch_many(scrape: Callable[[str, str], List[dict]], stores: List[str], q: str,
                timeout: float) -> Dict[str, List[dict]]:
    """
    Every store in `stores` fetched concurrently. A store that raises, or
    hasn't finished within `timeout` seconds, is simply absent from the
    result (the caller treats that exactly like an empty answer — falling
    back to a stale cache entry, or "unavailable"). A store that times out
    keeps running in its own thread in the background; see the module
    docstring for why that's safe to just walk away from.
    """
    results: Dict[str, List[dict]] = {}
    if not stores:
        return results
    pool = ThreadPoolExecutor(max_workers=len(stores))
    try:
        futures = {pool.submit(scrape, store, q): store for store in stores}
        try:
            for future in as_completed(futures, timeout=timeout):
                store = futures[future]
                try:
                    results[store] = future.result()
                except Exception:
                    log.exception("live search for %r failed in the %s scraper", q, store)
        except FutureTimeoutError:
            done = {futures[f] for f in futures if f.done()}
            log.warning("live search timed out after %.1fs waiting on: %s",
                       timeout, ", ".join(sorted(set(stores) - done)) or "?")
    finally:
        # Don't block returning results on a store we've already given up on
        # — a still-running thread finishes on its own (its own scraper sets
        # its own request timeout) and is simply not waited for here.
        pool.shutdown(wait=False)
    return results


def _own_rows(store: str, products: List[dict]) -> List[dict]:
    """Only rows labelled with this store's name are saved — nothing else gets into items."""
    name = store_name(store)
    own = [p for p in products if p.get("store") == name]
    if len(own) != len(products):
        log.warning("%s scraper returned %d row(s) for another store — dropped",
                    store, len(products) - len(own))
    return own


def _is_fresh(searched_at: datetime) -> bool:
    return searched_at > datetime.now(timezone.utc) - cache_ttl()


def _cached(conn, store: str, q: str):
    """(searched_at, items) from the last search of this store for q, or None."""
    with conn.cursor() as cur:
        cur.execute("SELECT searched_at FROM live_searches WHERE store = %s AND query = %s",
                    (store, q))
        row = cur.fetchone()
    if row is None:
        return None
    return _first(row), _items_for(conn, store, q)


def _items_for(conn, store: str, q: str) -> List[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """SELECT i.id, i.name, i.price, i.last_known_price, i.last_priced_at,
                      i.image_url, i.product_url, i.store,
                      i.brand, i.category, i.on_promotion, i.in_stock, i.last_updated
               FROM live_searches s
               JOIN live_search_results r ON r.search_id = s.id
               JOIN items i ON i.id = r.item_id
               WHERE s.store = %s AND s.query = %s
                 AND i.store = %s              -- never another store's rows
               -- buyable first (in stock with a real price), then the store's order
               ORDER BY (i.in_stock AND i.price IS NOT NULL) DESC, r.rank""",
            (store, q, store_name(store)),
        )
        cols = [d[0] for d in cur.description]
        return [row if isinstance(row, dict) else dict(zip(cols, row)) for row in cur.fetchall()]


def _remember(conn, store: str, q: str, item_ids: List[int]) -> datetime:
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO live_searches (store, query, searched_at, result_count)
               VALUES (%s, %s, NOW(), %s)
               ON CONFLICT (store, query)
               DO UPDATE SET searched_at = NOW(), result_count = EXCLUDED.result_count
               RETURNING id, searched_at""",
            (store, q, len(item_ids)),
        )
        row = cur.fetchone()
        search_id, searched_at = (row["id"], row["searched_at"]) if isinstance(row, dict) else row
        cur.execute("DELETE FROM live_search_results WHERE search_id = %s", (search_id,))
        if item_ids:
            cur.executemany(
                "INSERT INTO live_search_results (search_id, item_id, rank) VALUES (%s, %s, %s)",
                [(search_id, item_id, rank) for rank, item_id in enumerate(item_ids)],
            )
    return searched_at


def _first(row):
    return next(iter(row.values())) if isinstance(row, dict) else row[0]
