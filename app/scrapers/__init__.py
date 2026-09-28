"""
Live store search — which stores the live search flow calls.

SCRAPERS lists every store with a live scraper as "module:function" strings,
and LIVE_PRICE_STORES (env, comma-separated) says which of them are switched
on. Every scraper exposes the same search(query) contract. Only switched-on
scrapers are imported, so an unfinished one can sit outside SCRAPERS until it
has been investigated.

    LIVE_PRICE_STORES=checkers              (default — Checkers Sixty60 only)
    LIVE_PRICE_STORES=checkers,shoprite,pnp (once those scrapers are ready)

To add a store: investigate its real site first, then write
app/scrapers/<store>.py with `search(query) -> list[dict]` that never raises,
add its key and display name below, then add the key to LIVE_PRICE_STORES.

The same setting also limits app/price_feed (the older CSV / RapidAPI import
into product_offers, run by hand): its refresh and probe commands skip any
store that isn't listed here.
"""

from __future__ import annotations

import importlib
import logging
import os
from concurrent.futures import ThreadPoolExecutor, wait
from typing import Callable, Dict, List

from dotenv import load_dotenv

load_dotenv()

log = logging.getLogger(__name__)

SCRAPERS: Dict[str, str] = {
    "checkers": "app.scrapers.checkers:search",   # Checkers Sixty60
    "shoprite": "app.scrapers.shoprite:search",   # same platform as Checkers — see
                                                   # app/scrapers/sixty60_platform.py
    "superbhyper": "app.scrapers.superbhyper:search",  # Durban Metro & North Coast — WooCommerce
}

# The `store` value each scraper writes into its results (and so into
# items.store). Live search only ever returns items.store rows that belong to
# a switched-on store, so old rows from a switched-off store can't leak in.
STORE_NAMES: Dict[str, str] = {
    "checkers": "Checkers",
    "shoprite": "Shoprite",
    "pnp": "Pick n Pay",
    "superbhyper": "SuperbHyper",
}

DEFAULT_LIVE_STORES = "checkers"
DEFAULT_STORE_TIMEOUT_SECONDS = 8.0


def enabled_stores() -> List[str]:
    """Every store key listed in LIVE_PRICE_STORES, lower-cased, in order, no duplicates."""
    raw = os.getenv("LIVE_PRICE_STORES", DEFAULT_LIVE_STORES)
    stores: List[str] = []
    for key in (k.strip().lower() for k in raw.split(",")):
        if key and key not in stores:
            stores.append(key)
    return stores


def active_stores() -> List[str]:
    """Enabled stores that have a live scraper — what live search calls."""
    stores = []
    for key in enabled_stores():
        if key not in SCRAPERS:
            log.info("LIVE_PRICE_STORES lists %r, which has no live scraper in "
                     "app/scrapers/__init__.py — live search skips it", key)
            continue
        stores.append(key)
    return stores


def store_name(store: str) -> str:
    """items.store value for a store key: 'checkers' -> 'Checkers'."""
    return STORE_NAMES.get(store, store.title())


def is_enabled(store: str) -> bool:
    """Is this store key listed in LIVE_PRICE_STORES? Used by app/price_feed,
    whose stores (e.g. 'picknpay' via RapidAPI) needn't have a live scraper."""
    return (store or "").strip().lower() in enabled_stores()


def get_scraper(store: str) -> Callable[[str], List[dict]]:
    module_name, func_name = SCRAPERS[store].split(":")
    return getattr(importlib.import_module(module_name), func_name)


def search_store(store: str, query: str) -> List[dict]:
    """One store's results for `query`; [] (logged) if its scraper fails."""
    try:
        return get_scraper(store)(query)
    except Exception:
        log.exception("live search for %r failed in the %s scraper", query, store)
        return []


def store_timeout_seconds() -> float:
    try:
        seconds = float(os.getenv("LIVE_STORE_TIMEOUT_SECONDS",
                                   DEFAULT_STORE_TIMEOUT_SECONDS))
    except ValueError:
        seconds = DEFAULT_STORE_TIMEOUT_SECONDS
    return max(0.5, min(seconds, 30.0))


def parallel_search(stores: List[str], query: str,
                    scrape: Callable[[str, str], List[dict]] = search_store
                    ) -> Dict[str, List[dict]]:
    """Run enabled-store searches together without letting one block the rest."""
    if not stores:
        return {}

    executor = ThreadPoolExecutor(max_workers=len(stores),
                                  thread_name_prefix="live-store")
    futures = {
        executor.submit(scrape, store, query): store
        for store in stores
    }
    done, pending = wait(futures, timeout=store_timeout_seconds())
    results: Dict[str, List[dict]] = {}

    for future in done:
        store = futures[future]
        try:
            results[store] = future.result() or []
        except Exception:
            log.exception("live search for %r failed in the %s scraper",
                          query, store)
            results[store] = []

    for future in pending:
        store = futures[future]
        future.cancel()
        log.warning("live search for %r timed out in the %s scraper",
                    query, store)
        results[store] = []

    # Do not wait for a timed-out network call. Scrapers also have their own
    # request timeout, so the worker will exit shortly after cancellation.
    executor.shutdown(wait=False, cancel_futures=True)
    return results


def search_live(query: str) -> List[dict]:
    """Every active store's results for `query`, in registry order."""
    stores = active_stores()
    results_by_store = parallel_search(stores, query)
    results: List[dict] = []
    for store in stores:
        results.extend(results_by_store.get(store, []))
    return results
