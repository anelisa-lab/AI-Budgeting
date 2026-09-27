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

app/price_feed (CSV + RapidAPI import, run from the command line) is a
separate, older path and is not part of this.
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

DEFAULT_LIVE_STORES = "checkers"


def active_stores() -> List[str]:
    """Store keys switched on by LIVE_PRICE_STORES, in order; unknown keys are logged and dropped."""
    raw = os.getenv("LIVE_PRICE_STORES", DEFAULT_LIVE_STORES)
    stores = []
    for key in (k.strip().lower() for k in raw.split(",")):
        if not key or key in stores:
            continue
        if key not in SCRAPERS:
            log.warning("LIVE_PRICE_STORES names %r, which has no scraper in "
                        "app/scrapers/__init__.py — ignored", key)
            continue
        stores.append(key)
    return stores


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
