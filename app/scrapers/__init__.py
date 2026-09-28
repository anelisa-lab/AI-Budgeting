"""
Live store search — which stores the live search flow calls.

SCRAPERS lists every store we have a live scraper for, as "module:function"
strings, and LIVE_PRICE_STORES (env, comma-separated) says which of them are
switched on. Only switched-on scrapers are imported, so an unfinished one
can sit in SCRAPERS without being loaded or called.

    LIVE_PRICE_STORES=checkers              (default — Checkers Sixty60 only)
    LIVE_PRICE_STORES=checkers,picknpay     (once a Pick n Pay scraper exists)

To add a store: write app/scrapers/<store>.py with a
`search_<store>(query) -> list[dict]` that never raises, add it below, then
add its key to LIVE_PRICE_STORES.

The same setting also limits app/price_feed (the older CSV / RapidAPI import
into product_offers, run by hand): its refresh and probe commands skip any
store that isn't listed here.
"""

from __future__ import annotations

import importlib
import logging
import os
from typing import Callable, Dict, List

from dotenv import load_dotenv

load_dotenv()

log = logging.getLogger(__name__)

SCRAPERS: Dict[str, str] = {
    "checkers": "app.scrapers.checkers:search_checkers",   # Checkers Sixty60
}

# The `store` value each scraper writes into its results (and so into
# items.store). Live search only ever returns items.store rows that belong to
# a switched-on store, so old rows from a switched-off store can't leak in.
#
# Keys not yet in SCRAPERS are harmless here (active_stores() only returns
# keys that ARE in SCRAPERS) — pre-naming a store before its scraper exists
# just means one less line to add later.
STORE_NAMES: Dict[str, str] = {
    "checkers": "Checkers",
    "shoprite": "Shoprite",
    "picknpay": "Pick n Pay",   # matches stores.external_store_id / price_feed's key, not "pnp"
}

DEFAULT_LIVE_STORES = "checkers"


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


def search_live(query: str) -> List[dict]:
    """Every active store's results for `query`. A failing store is logged and skipped."""
    results: List[dict] = []
    for store in active_stores():
        results.extend(search_store(store, query))
    return results
