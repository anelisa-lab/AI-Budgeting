"""
Live product search on superbhyper.co.za — same-day grocery delivery for
Durban Metro & the North Coast, built on WooCommerce/WordPress.

robots.txt (superbhyper.co.za/robots.txt, checked 2026-09) disallows only
/wp-admin/, add-to-cart action URLs and internal log/upload paths — nothing
about search or product pages. Unlike Checkers/Shoprite this is plain,
server-rendered HTML, not a JSON API: a GET to

    https://superbhyper.co.za/?s=<query>&post_type=product

returns WooCommerce's standard shop-loop markup, confirmed against real
"bread" results:
  - name:      .woocommerce-loop-product__title
  - price:     .woocommerce-Price-amount (an <ins> price wins over a
               struck-through <del> one when a product is on promotion)
  - stock:     the "instock" / "outofstock" class WooCommerce core puts on
               each product <li> ("instock" confirmed on real results;
               "outofstock" is that same convention's documented opposite —
               no out-of-stock sample came up in what was searched)
  - image:     the product thumbnail's <img src>
  - product/SKU: the product link's href; data-product_sku on the
               add-to-cart button when there is one (falling back to
               data-product_id for a variable/grouped product). An
               out-of-stock product may have no add-to-cart button at all
               (WooCommerce's default template swaps it for a plain "Read
               more" link), so the product URL's own slug — always present,
               always unique — is the final fallback rather than dropping
               the product.

It's the site's own default WooCommerce template, so it can change without
notice: anything unexpected logs a warning and returns [] instead of raising.

Standalone check before wiring it into the app:

    python -m app.scrapers.superbhyper bread
"""

from __future__ import annotations

import logging
import re
from typing import List, Optional

import requests
from bs4 import BeautifulSoup

from app.scrapers.common import DEFAULT_REQUEST_TIMEOUT, USER_AGENT, looks_blocked

log = logging.getLogger(__name__)

BASE_URL = "https://superbhyper.co.za"
STORE = "SuperbHyper"
STORE_KEY = "superbhyper"
PAGE_SIZE = 40
_PRICE_RE = re.compile(r"\d+\.\d{2}")


def search(query: str, limit: int = PAGE_SIZE,
           session: Optional[requests.Session] = None) -> List[dict]:
    """Search superbhyper.co.za. Never raises: any failure logs a warning and returns []."""
    query = (query or "").strip()
    if not query:
        return []
    html = fetch_raw(query, session)
    if html is None:
        return []
    return parse_products(html)[:limit]


def fetch_raw(query: str, session: Optional[requests.Session] = None,
              timeout: int = DEFAULT_REQUEST_TIMEOUT) -> Optional[str]:
    """The search results page's HTML, or None (logged) on any failure."""
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-ZA,en;q=0.9",
    }
    http = session or requests
    try:
        response = http.get(f"{BASE_URL}/", params={"s": query, "post_type": "product"},
                            headers=headers, timeout=timeout)
    except requests.RequestException as exc:
        log.warning("superbhyper request failed for %r: %s", query, exc)
        return None
    if response.status_code != 200:
        log.warning("superbhyper returned HTTP %s for %r", response.status_code, query)
        return None
    if looks_blocked(response.text):
        log.warning("superbhyper appears to have blocked the search for %r — "
                    "no results this time", query)
        return None
    return response.text


def parse_products(html: str) -> List[dict]:
    soup = BeautifulSoup(html, "html.parser")
    out, seen = [], set()
    for li in soup.select("ul.products > li"):
        product = _to_product(li)
        if product is None:
            log.debug("skipping unparseable superbhyper product")
            continue
        if product["sku"] in seen:
            continue
        seen.add(product["sku"])
        out.append(product)
    return out


def _to_product(li) -> Optional[dict]:
    title_el = li.select_one(".woocommerce-loop-product__title")
    link_el = li.select_one("a.woocommerce-LoopProduct-link")
    name = title_el.get_text(strip=True) if title_el else None
    product_url = link_el.get("href") if link_el else None
    if not name or not product_url:
        return None

    button = li.select_one(".add_to_cart_button")
    sku = (button.get("data-product_sku") if button else None) \
        or (button.get("data-product_id") if button else None)
    if not sku:
        # No add-to-cart button at all (e.g. an out-of-stock product, which
        # WooCommerce's default template shows a plain "Read more" link for
        # instead) — the URL's own slug is always present and unique.
        sku = product_url.rstrip("/").rsplit("/", 1)[-1]
    if not sku:
        return None

    classes = li.get("class") or []
    in_stock = "outofstock" not in classes

    img_el = li.select_one("img")

    return {
        "name": name,
        "price": _price(li) if in_stock else None,
        "image_url": img_el.get("src") if img_el else None,
        "product_url": product_url,
        "sku": str(sku),
        "brand": None,     # not exposed on the search-results grid
        "on_promotion": li.select_one("span.onsale") is not None,
        "in_stock": in_stock,
        "store": STORE,
    }


def _price(li) -> Optional[float]:
    """
    The price you pay: an on-promotion product shows both a struck-through
    <del> (regular) and an <ins> (sale) amount, so <ins> is checked first.
    Never 0 — a product with no readable price amount returns None.
    """
    price_el = (li.select_one("ins .woocommerce-Price-amount")
                or li.select_one(".woocommerce-Price-amount"))
    if price_el is None:
        return None
    match = _PRICE_RE.search(price_el.get_text(strip=True).replace(",", ""))
    if not match:
        return None
    value = float(match.group())
    return value if value > 0 else None


# ---------------------------------------------------------------------------
# Standalone check
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse
    import json

    parser = argparse.ArgumentParser(description="Search superbhyper.co.za and print the results")
    parser.add_argument("query", nargs="?", default="bread")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    results = search(args.query)
    print(json.dumps(results, indent=2, ensure_ascii=False))
    print(f"\n{len(results)} product(s) for {args.query!r}")
