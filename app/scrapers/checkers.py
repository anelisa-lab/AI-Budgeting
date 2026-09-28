"""
Live product search on checkers.co.za.

The search page (https://www.checkers.co.za/search?Search=bread) is a static
Next.js export: its __NEXT_DATA__ has an empty pageProps, and the browser
loads the products afterwards with

    POST https://www.checkers.co.za/api/catalogue/get-products-filter
    {"storeContexts": [...], "filterData": {"filter": {"productListSource":
     {"search": "bread"}, "paginationOptions": {"page": 0, "pageSize": 40}, ...}}}

which answers {"products": [...], "totalCount": N}. That's what we call.
It's the site's own, undocumented endpoint, so it can change without notice:
anything unexpected logs a warning and returns [] instead of raising.

With no storeContexts the site picks its default stores, so prices are
those stores' prices (Checkers prices are mostly national).

Shoprite (app/scrapers/shoprite.py) was found to run the exact same
platform — this module's fetch/parse logic now lives in
app/scrapers/sixty60_platform.py, shared by both, rather than being copied.
This file is the thin, Checkers-specific wrapper: its base URL, its display
name, and its own standalone CLI.

Standalone check before wiring it into the app:

    python -m app.scrapers.checkers bread
    python -m app.scrapers.checkers bread --raw     # the unprocessed JSON of the first product
"""

from __future__ import annotations

from typing import List, Optional

import requests

from app.scrapers.sixty60_platform import fetch_raw as _fetch_raw
from app.scrapers.sixty60_platform import parse_products as _parse_products
from app.scrapers.sixty60_platform import slugify as _slugify

BASE_URL = "https://www.checkers.co.za"
STORE = "Checkers"
STORE_KEY = "checkers"
PAGE_SIZE = 40


def search(query: str, limit: int = PAGE_SIZE,
           session: Optional[requests.Session] = None) -> List[dict]:
    """Search checkers.co.za. Never raises: any failure logs a warning and returns []."""
    query = (query or "").strip()
    if not query:
        return []
    payload = fetch_raw(query, limit, session)
    if payload is None:
        return []
    return parse_products(payload)


def search_checkers(query: str, limit: int = PAGE_SIZE,
                    session: Optional[requests.Session] = None) -> List[dict]:
    """Backward-compatible name for older callers of the Checkers scraper."""
    return search(query, limit=limit, session=session)


def fetch_raw(query: str, limit: int = PAGE_SIZE,
              session: Optional[requests.Session] = None) -> Optional[dict]:
    """The API's JSON response, or None (logged) if the call didn't work."""
    return _fetch_raw(BASE_URL, query, STORE_KEY, limit, session)


def parse_products(payload: dict) -> List[dict]:
    return _parse_products(payload, BASE_URL, STORE)


# ---------------------------------------------------------------------------
# Standalone check
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse
    import json
    import logging

    parser = argparse.ArgumentParser(description="Search checkers.co.za and print the results")
    parser.add_argument("query", nargs="?", default="bread")
    parser.add_argument("--raw", action="store_true",
                        help="print the first product exactly as the API returned it")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    raw = fetch_raw(args.query)
    if args.raw and raw and raw["products"]:
        print(json.dumps(raw["products"][0], indent=2, ensure_ascii=False))
    results = parse_products(raw) if raw else []
    print(json.dumps(results, indent=2, ensure_ascii=False))
    total = raw.get("totalCount") if raw else 0
    print(f"\n{len(results)} product(s) for {args.query!r} (Checkers reports {total} matches)")
