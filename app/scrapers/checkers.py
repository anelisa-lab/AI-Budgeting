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

Standalone check before wiring it into the app:

    python -m app.scrapers.checkers bread
    python -m app.scrapers.checkers bread --raw     # the unprocessed JSON of the first product
"""

from __future__ import annotations

import logging
import re
import unicodedata
from typing import List, Optional

import requests

log = logging.getLogger(__name__)

BASE_URL = "https://www.checkers.co.za"
API_URL = BASE_URL + "/api/catalogue/get-products-filter"
STORE = "Checkers"
TIMEOUT = 20
PAGE_SIZE = 40

HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"),
    "Accept": "application/json",
    "Accept-Language": "en-ZA,en;q=0.9",
    "Origin": BASE_URL,
}


def search_checkers(query: str, limit: int = PAGE_SIZE,
                    session: Optional[requests.Session] = None) -> List[dict]:
    """Search checkers.co.za. Never raises: any failure logs a warning and returns []."""
    query = (query or "").strip()
    if not query:
        return []
    payload = fetch_raw(query, limit, session)
    if payload is None:
        return []
    return parse_products(payload)


def fetch_raw(query: str, limit: int = PAGE_SIZE,
              session: Optional[requests.Session] = None) -> Optional[dict]:
    """The API's JSON response, or None (logged) if the call didn't work."""
    body = {
        "storeContexts": [],
        "filterData": {
            "filter": {
                "showAllDisplayVariants": False,
                "showNotRangedProducts": True,
                "productListSource": {"search": query},
                "paginationOptions": {"page": 0, "pageSize": limit},
                "filterOptions": {"dealsOnly": False, "serviceOptions": []},
            },
            "displayOptions": {"includeDisplayCategoryTree": False},
        },
        "forYouBonusBuyIds": [],
        "isCarousel": False,
    }
    headers = {**HEADERS, "Referer": f"{BASE_URL}/search?Search={requests.utils.quote(query)}"}
    http = session or requests
    try:
        response = http.post(API_URL, json=body, headers=headers, timeout=TIMEOUT)
    except requests.RequestException as exc:
        log.warning("Checkers request failed for %r: %s", query, exc)
        return None

    # AWS WAF (Checkers' bot protection) answers a challenge with 202/405 and
    # this header, and flags rate limiting with its own header.
    waf_action = response.headers.get("x-amzn-waf-action")
    if waf_action or response.headers.get("x-amzn-waf-rate-limiting-exceeded") == "true":
        log.warning("Checkers bot protection blocked the search for %r (%s, HTTP %s) — "
                    "no results this time", query, waf_action or "rate limited",
                    response.status_code)
        return None
    if response.status_code != 200:
        log.warning("Checkers returned HTTP %s for %r", response.status_code, query)
        return None
    try:
        payload = response.json()
    except ValueError:
        log.warning("Checkers returned non-JSON for %r (%s): %.200s", query,
                    response.headers.get("content-type"), response.text)
        return None
    if not isinstance(payload, dict) or not isinstance(payload.get("products"), list):
        log.error("Checkers response has no 'products' list — the API has changed. "
                  "Keys: %s", list(payload)[:20] if isinstance(payload, dict) else type(payload).__name__)
        return None
    return payload


# ---------------------------------------------------------------------------
# Parsing (pure — testable without the network)
# ---------------------------------------------------------------------------


def parse_products(payload: dict) -> List[dict]:
    out, seen = [], set()
    for item in payload.get("products") or []:
        product = _to_product(item) if isinstance(item, dict) else None
        if product is None:
            log.debug("skipping unparseable Checkers product: %.200r", item)
            continue
        if product["sku"] in seen:     # same product listed for more than one store
            continue
        seen.add(product["sku"])
        out.append(product)
    return out


def _to_product(item: dict) -> Optional[dict]:
    """
    One product. price is None — never 0 — when Checkers has no price for it
    (out of stock, or no positive price in the JSON); in_stock says which.
    """
    name = (item.get("displayName") or item.get("name") or "").strip()
    sku = item.get("articleNumber") or item.get("id")
    if not name or not sku:
        return None
    in_stock = _in_stock(item)
    return {
        "name": name,
        "price": _price(item) if in_stock else None,
        "image_url": (item.get("imageProductCardURL") or item.get("imageURL")
                      or item.get("imagePDPURL")),
        "product_url": product_url(item),
        "sku": str(sku),
        "brand": item.get("brand"),
        "on_promotion": bool(item.get("isOnPromotion")),
        "in_stock": in_stock,
        "store": STORE,
    }


def _in_stock(item: dict) -> bool:
    """
    Checkers marks an unavailable product with "outOfStock": true and
    "isStockAvailable": false (and sends price 0, priceWithoutDecimal 0,
    discountedPrice null). Either flag means out of stock.
    """
    return not item.get("outOfStock", False) and item.get("isStockAvailable", True) is not False


def _price(item: dict) -> Optional[float]:
    """
    The price you pay in rand: the lower of price and discountedPrice. Only
    positive numbers count — Checkers sends 0 for "no price", which must never
    become R0 — so this returns None rather than 0.
    """
    prices = []
    for key in ("price", "discountedPrice"):
        value = item.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
            prices.append(float(value))
    cents = item.get("priceWithoutDecimal")
    if not prices and isinstance(cents, int) and not isinstance(cents, bool) and cents > 0:
        prices.append(cents / (item.get("priceFactor") or 100))
    return round(min(prices), 2) if prices else None


def product_url(item: dict) -> str:
    """Same rule as the site's own links: /product/<slug>-<articleNumber><unitOfMeasure>."""
    slug = _slugify(item.get("name") or "")
    if item.get("articleNumber") and item.get("unitOfMeasure"):
        return f"{BASE_URL}/product/{slug}-{item['articleNumber']}{item['unitOfMeasure']}"
    return f"{BASE_URL}/product/{slug}-{item.get('id', '')}"


def _slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"\s+", "-", text.lower())
    text = re.sub(r"[/_,:;]", "-", text).replace("&", "-and-")
    text = re.sub(r"[^\w-]+", "", text)
    return re.sub(r"--+", "-", text).strip("-")


# ---------------------------------------------------------------------------
# Standalone check
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse
    import json

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
