"""
Live product search on shoprite.co.za.

Investigated directly (2026-09), the same way Checkers was:

  - robots.txt (User-agent: *) disallows only /login/* and /my-profile/* —
    search and the catalogue API are not disallowed.
  - The search page (https://www.shoprite.co.za/search?q=bread) is a static
    Next.js export: its __NEXT_DATA__ has an empty pageProps, same as
    Checkers.
  - Its search-page JS chunk is BYTE-IDENTICAL to Checkers' — same content
    hash, static/chunks/pages/search-76c0e40c26345ade.js — and its bundle
    calls the same platform API:

        POST https://www.shoprite.co.za/api/catalogue/get-products-filter
        {"storeContexts": [...], "filterData": {"filter": {"productListSource":
         {"search": "bread"}, "paginationOptions": {"page": 0, "pageSize": 40}, ...}}}

    confirmed by calling it directly: real products came back with the same
    field names as Checkers' (outOfStock, isStockAvailable, priceWithoutDecimal,
    articleNumber, ...), and product images on the same catalog.sixty60.co.za
    CDN. So this module is a thin wrapper around
    app/scrapers/sixty60_platform.py rather than a second copy of Checkers'
    parsing code — see that module for exactly what is shared and why.

  - Unlike Checkers, an empty storeContexts POST returns real products on
    the very first call — no need to GET the search page first to pick up a
    default-store cookie.

Standalone check before wiring it into the app:

    python -m app.scrapers.shoprite bread
    python -m app.scrapers.shoprite bread --raw     # the unprocessed JSON of the first product
"""

from __future__ import annotations

from typing import List, Optional

import requests

from app.scrapers.sixty60_platform import fetch_raw as _fetch_raw
from app.scrapers.sixty60_platform import parse_products as _parse_products

BASE_URL = "https://www.shoprite.co.za"
STORE = "Shoprite"
STORE_KEY = "shoprite"


def search(query: str, limit: int = 40,
           session: Optional[requests.Session] = None) -> List[dict]:
    """Search shoprite.co.za. Never raises: any failure logs a warning and returns []."""
    query = (query or "").strip()
    if not query:
        return []
    payload = fetch_raw(query, limit, session)
    if payload is None:
        return []
    return parse_products(payload)


def fetch_raw(query: str, limit: int = 40,
              session: Optional[requests.Session] = None) -> Optional[dict]:
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

    parser = argparse.ArgumentParser(description="Search shoprite.co.za and print the results")
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
    print(f"\n{len(results)} product(s) for {args.query!r} (Shoprite reports {total} matches)")
