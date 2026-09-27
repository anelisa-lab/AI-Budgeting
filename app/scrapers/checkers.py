"""
Live product search on checkers.co.za.

Checkers' site is Next.js: a search page loaded directly
(https://www.checkers.co.za/search?Search=bread) ships its whole result list
inside <script id="__NEXT_DATA__" type="application/json">, so one GET and a
JSON parse is enough — no private API.

We don't hard-code the exact path to the product list
(props.pageProps.<something>...), because Next.js sites move that around
between deploys. Instead the JSON is walked and the largest list of
"product-shaped" objects (has a name and a price) wins. When nothing
matches, the top-level keys are logged so the parser can be adjusted.

Standalone check before wiring it into the app:

    python -m app.scrapers.checkers bread
    python -m app.scrapers.checkers bread --dump next_data.json   # save the raw JSON too
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Iterator, List, Optional
from urllib.parse import quote_plus, urljoin

import requests
from bs4 import BeautifulSoup

from app.price_feed.providers import parse_price

log = logging.getLogger(__name__)

BASE_URL = "https://www.checkers.co.za"
SEARCH_URL = BASE_URL + "/search?Search={query}"
STORE = "Checkers"
TIMEOUT = 20

HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-ZA,en;q=0.9",
}

_NAME_KEYS = ("name", "title", "productName", "displayName", "description")
_PRICE_KEYS = ("price", "currentPrice", "sellingPrice", "salePrice", "priceValue",
               "finalPrice", "amount")
_PRICE_INNER_KEYS = ("value", "amount", "price", "current", "formattedValue", "formatted")
_IMAGE_KEYS = ("image", "imageUrl", "image_url", "thumbnail", "thumbnailUrl",
               "images", "media", "primaryImage")
_URL_KEYS = ("url", "productUrl", "product_url", "link", "href", "slug", "path")
_ID_KEYS = ("sku", "code", "productCode", "productId", "id", "articleNumber", "ean")

_CHALLENGE_MARKERS = ("cf-challenge", "challenge-platform", "Just a moment...",
                      "cf_chl_", "Attention Required! | Cloudflare", "captcha")


def search_checkers(query: str, session: Optional[requests.Session] = None) -> List[dict]:
    """Search checkers.co.za. Never raises: any failure logs a warning and returns []."""
    query = (query or "").strip()
    if not query:
        return []
    html = _fetch(query, session)
    if html is None:
        return []
    data = extract_next_data(html)
    if data is None:
        return []
    return parse_products(data)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


def _fetch(query: str, session: Optional[requests.Session]) -> Optional[str]:
    url = SEARCH_URL.format(query=quote_plus(query))
    http = session or requests
    try:
        response = http.get(url, headers=HEADERS, timeout=TIMEOUT)
    except requests.RequestException as exc:
        log.warning("Checkers request failed for %r: %s", query, exc)
        return None

    if _looks_like_challenge(response):
        log.warning("Checkers returned a bot-challenge page (HTTP %s) for %r — "
                    "no results this time", response.status_code, query)
        return None
    if response.status_code != 200:
        log.warning("Checkers returned HTTP %s for %r", response.status_code, query)
        return None
    return response.text


def _looks_like_challenge(response: requests.Response) -> bool:
    if response.headers.get("cf-mitigated") == "challenge":
        return True
    if response.status_code in (403, 429, 503):
        head = response.text[:5000]
        return any(marker in head for marker in _CHALLENGE_MARKERS)
    return False


# ---------------------------------------------------------------------------
# Parsing (pure functions — testable without the network)
# ---------------------------------------------------------------------------


def extract_next_data(html: str) -> Optional[dict]:
    """The parsed JSON of <script id="__NEXT_DATA__">, or None (logged)."""
    tag = BeautifulSoup(html, "html.parser").find("script", id="__NEXT_DATA__")
    if tag is None or not tag.string:
        log.error("Checkers page has no __NEXT_DATA__ script — the site layout has "
                  "changed or this isn't a search page (%d bytes of HTML)", len(html))
        return None
    try:
        return json.loads(tag.string)
    except json.JSONDecodeError as exc:
        log.error("Checkers __NEXT_DATA__ is not valid JSON: %s", exc)
        return None


def parse_products(data: Any) -> List[dict]:
    """Find the product list anywhere in the __NEXT_DATA__ JSON and normalise it."""
    best: List[dict] = []
    best_path = ""
    for path, items in _candidate_lists(data):
        products = [p for p in (_to_product(item) for item in items) if p]
        if len(products) > len(best):
            best, best_path = products, path

    if not best:
        page_props = data.get("props", {}).get("pageProps", {}) if isinstance(data, dict) else {}
        log.error("No product list found in Checkers __NEXT_DATA__. "
                  "Top-level keys: %s; pageProps keys: %s. Run with --dump and "
                  "adjust app/scrapers/checkers.py.",
                  list(data)[:20] if isinstance(data, dict) else type(data).__name__,
                  list(page_props)[:30] if isinstance(page_props, dict) else "-")
        return []

    log.debug("Checkers products found at %s (%d items)", best_path, len(best))
    # One product can appear in several lists (e.g. results + "sponsored")
    seen, unique = set(), []
    for product in best:
        key = product["sku"] or product["product_url"] or product["name"]
        if key not in seen:
            seen.add(key)
            unique.append(product)
    return unique


def _candidate_lists(node: Any, path: str = "$") -> Iterator[tuple]:
    """Every list of dicts in the tree, with a JSONPath-ish label for logging."""
    if isinstance(node, dict):
        for key, value in node.items():
            yield from _candidate_lists(value, f"{path}.{key}")
    elif isinstance(node, list):
        if node and all(isinstance(x, dict) for x in node):
            yield path, node
        for i, value in enumerate(node):
            yield from _candidate_lists(value, f"{path}[{i}]")


def _to_product(item: dict) -> Optional[dict]:
    name = _first_str(item, _NAME_KEYS)
    price = _price(item)
    if not name or price is None or price <= 0:
        return None
    url = _first_str(item, _URL_KEYS)
    return {
        "name": name.strip(),
        "price": float(price),
        "image_url": _image(item),
        "product_url": _absolute(url) if url else None,
        "sku": _first_scalar(item, _ID_KEYS),
        "store": STORE,
    }


def _first_str(d: dict, keys) -> Optional[str]:
    for k in keys:
        v = d.get(k)
        if isinstance(v, str) and v.strip():
            return v
    return None


def _first_scalar(d: dict, keys) -> Optional[str]:
    for k in keys:
        v = d.get(k)
        if isinstance(v, (str, int)) and not isinstance(v, bool) and str(v).strip():
            return str(v)
    return None


def _price(item: dict):
    for k in _PRICE_KEYS:
        v = item.get(k)
        if isinstance(v, dict):                 # {"value": 18.99, "formattedValue": "R18.99"}
            v = next((v[i] for i in _PRICE_INNER_KEYS if v.get(i) not in (None, "")), None)
        price = parse_price(v)
        if price is not None:
            return price
    return None


def _image(item: dict) -> Optional[str]:
    for k in _IMAGE_KEYS:
        url = _image_url(item.get(k))
        if url:
            return _absolute(url)
    return None


def _image_url(v: Any) -> Optional[str]:
    if isinstance(v, str) and v.strip():
        return v.strip()
    if isinstance(v, list):
        for entry in v:
            url = _image_url(entry)
            if url:
                return url
    if isinstance(v, dict):
        for k in ("url", "src", "href", "imageUrl", "original", "large", "medium"):
            if isinstance(v.get(k), str) and v[k].strip():
                return v[k].strip()
    return None


def _absolute(url: str) -> str:
    url = url.strip()
    if url.startswith("//"):
        return "https:" + url
    if re.match(r"^https?://", url):
        return url
    return urljoin(BASE_URL + "/", url.lstrip("/"))


# ---------------------------------------------------------------------------
# Standalone check
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Search checkers.co.za and print the results")
    parser.add_argument("query", nargs="?", default="bread")
    parser.add_argument("--dump", metavar="FILE",
                        help="also save the raw __NEXT_DATA__ JSON here, to inspect its structure")
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG, format="%(levelname)s %(name)s: %(message)s")

    if args.dump:
        page = _fetch(args.query, None)
        raw = extract_next_data(page) if page else None
        if raw is not None:
            with open(args.dump, "w", encoding="utf-8") as fh:
                json.dump(raw, fh, indent=2, ensure_ascii=False)
            print(f"raw __NEXT_DATA__ written to {args.dump}")
        results = parse_products(raw) if raw is not None else []
    else:
        results = search_checkers(args.query)

    print(json.dumps(results, indent=2, ensure_ascii=False))
    print(f"\n{len(results)} product(s) for {args.query!r}")
