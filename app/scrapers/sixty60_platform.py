"""
Shared parsing for stores built on Shoprite Holdings' "Sixty60" catalogue
platform.

This is NOT a guess extended from Checkers to its sibling brands — it is
confirmed, per store, before that store's module imports this one:

  - the search page is the same static Next.js shell (__NEXT_DATA__ with
    empty pageProps)
  - its search-page JS chunk is BYTE-IDENTICAL across stores (same content
    hash — static/chunks/pages/search-76c0e40c26345ade.js for both
    checkers.co.za and shoprite.co.za, checked 2026-09)
  - the same POST /api/catalogue/get-products-filter endpoint, same request
    body shape, same response field names (outOfStock, isStockAvailable,
    priceWithoutDecimal, articleNumber, ...)
  - images served from the same catalog.sixty60.co.za CDN

Do NOT import this from a new store's module without first confirming the
above for that store's own site — see each store's own module docstring for
what was actually checked. A store that merely "looks similar" gets its own,
separately investigated module (e.g. app/scrapers/superbhyper.py), not this one.

Each store module supplies its own BASE_URL and STORE display name and gets
back the same fetch/parse pipeline Checkers already used.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from typing import List, Optional
from urllib.parse import quote

import requests

from app.scrapers.common import DEFAULT_REQUEST_TIMEOUT, USER_AGENT

log = logging.getLogger(__name__)

API_PATH = "/api/catalogue/get-products-filter"
PAGE_SIZE = 40


def headers_for(base_url: str) -> dict:
    return {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Accept-Language": "en-ZA,en;q=0.9",
        "Origin": base_url,
    }


def fetch_raw(base_url: str, query: str, store_key: str, limit: int = PAGE_SIZE,
              session: Optional[requests.Session] = None,
              timeout: int = DEFAULT_REQUEST_TIMEOUT) -> Optional[dict]:
    """The platform API's JSON response for one store, or None (logged) on any failure."""
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
    headers = {**headers_for(base_url),
              "Referer": f"{base_url}/search?Search={quote(query)}"}
    http = session or requests
    try:
        response = http.post(base_url + API_PATH, json=body, headers=headers, timeout=timeout)
    except requests.RequestException as exc:
        log.warning("%s request failed for %r: %s", store_key, query, exc)
        return None

    # AWS WAF (seen fronting Checkers) answers a challenge with 202/405 and
    # this header, and flags rate limiting with its own header. Other stores
    # on this platform may or may not sit behind the same WAF, so this is
    # checked defensively rather than assumed.
    waf_action = response.headers.get("x-amzn-waf-action")
    if waf_action or response.headers.get("x-amzn-waf-rate-limiting-exceeded") == "true":
        log.warning("%s bot protection blocked the search for %r (%s, HTTP %s) — "
                    "no results this time", store_key, query, waf_action or "rate limited",
                    response.status_code)
        return None
    if response.status_code != 200:
        log.warning("%s returned HTTP %s for %r", store_key, response.status_code, query)
        return None
    try:
        payload = response.json()
    except ValueError:
        log.warning("%s returned non-JSON for %r (%s): %.200s", store_key, query,
                    response.headers.get("content-type"), response.text)
        return None
    if not isinstance(payload, dict) or not isinstance(payload.get("products"), list):
        log.error("%s response has no 'products' list — the platform API has changed. "
                  "Keys: %s", store_key,
                  list(payload)[:20] if isinstance(payload, dict) else type(payload).__name__)
        return None
    return payload


def parse_products(payload: dict, base_url: str, store: str) -> List[dict]:
    out, seen = [], set()
    for item in payload.get("products") or []:
        product = _to_product(item, base_url, store) if isinstance(item, dict) else None
        if product is None:
            log.debug("skipping unparseable %s product: %.200r", store, item)
            continue
        if product["sku"] in seen:     # same product listed for more than one store branch
            continue
        seen.add(product["sku"])
        out.append(product)
    return out


def _to_product(item: dict, base_url: str, store: str) -> Optional[dict]:
    """
    One product. price is None — never 0 — when the platform has no price
    for it (out of stock, or no positive price in the JSON); in_stock says
    which.
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
        "product_url": product_url(item, base_url),
        "sku": str(sku),
        "brand": item.get("brand"),
        "on_promotion": bool(item.get("isOnPromotion")),
        "in_stock": in_stock,
        "store": store,
    }


def _in_stock(item: dict) -> bool:
    """
    The platform marks an unavailable product with "outOfStock": true and
    "isStockAvailable": false (and sends price 0, priceWithoutDecimal 0,
    discountedPrice null). Either flag means out of stock.
    """
    return not item.get("outOfStock", False) and item.get("isStockAvailable", True) is not False


def _price(item: dict) -> Optional[float]:
    """
    The price you pay in rand: the lower of price and discountedPrice. Only
    positive numbers count — the platform sends 0 for "no price", which must
    never become R0 — so this returns None rather than 0.
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


def product_url(item: dict, base_url: str) -> str:
    """Same rule as the platform's own links: /product/<slug>-<articleNumber><unitOfMeasure>."""
    slug = slugify(item.get("name") or "")
    if item.get("articleNumber") and item.get("unitOfMeasure"):
        return f"{base_url}/product/{slug}-{item['articleNumber']}{item['unitOfMeasure']}"
    return f"{base_url}/product/{slug}-{item.get('id', '')}"


def slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"\s+", "-", text.lower())
    text = re.sub(r"[/_,:;]", "-", text).replace("&", "-and-")
    text = re.sub(r"[^\w-]+", "", text)
    return re.sub(r"--+", "-", text).strip("-")
