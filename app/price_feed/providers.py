"""
Where live prices come from.

Standard library only (urllib, csv) — no new dependency for the team to
install.
"""

from __future__ import annotations

import csv
import json
import os
import re
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Iterable, List, Optional, Sequence

from app.price_feed.models import LivePrice


def parse_price(value) -> Optional[Decimal]:
    """19.99, "19.99", "R 19,99", "R1 299.00" -> Decimal. None if it isn't a price."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float, Decimal)):
        return Decimal(str(value)).quantize(Decimal("0.01"))
    text = str(value).strip().replace("\u00a0", " ")
    text = re.sub(r"^[Rr]\s*", "", text).replace(" ", "")
    if re.fullmatch(r"\d+,\d{2}", text):
        text = text.replace(",", ".")
    text = text.replace(",", "")
    try:
        return Decimal(text).quantize(Decimal("0.01"))
    except InvalidOperation:
        return None


# ---------------------------------------------------------------------------
# Manually verified prices — works today
# ---------------------------------------------------------------------------


class CsvPriceProvider:
    """
    docs/prices/verified_prices.csv — prices a team member looked up on the
    retailer's own website (or on the shelf) and wrote down with the date and
    the page URL. Columns:

        store_key, product_name, brand, size, price, observed_at, source_url, checked_by

    store_key is stores.external_store_id ('checkers', 'picknpay', ...).
    Blank price rows are skipped, so the template can be filled in gradually.
    """

    name = "verified_manual"

    def __init__(self, path):
        self.path = Path(path)

    def covered_stores(self) -> List[str]:
        return sorted({l.store_key for l in self.fetch()})

    def fetch(self) -> List[LivePrice]:
        out = []
        with self.path.open(newline="", encoding="utf-8-sig") as fh:
            for row in csv.DictReader(fh):
                price = parse_price(row.get("price"))
                if price is None or price <= 0:
                    continue
                observed = row.get("observed_at") or ""
                try:
                    when = datetime.fromisoformat(observed.strip())
                except ValueError:
                    raise ValueError(
                        f"{self.path}: '{row.get('product_name')}' needs observed_at as YYYY-MM-DD"
                    )
                if when.tzinfo is None:
                    when = when.replace(tzinfo=timezone.utc)
                out.append(LivePrice(
                    store_key=row["store_key"].strip(),
                    title=f"{row.get('brand', '')} {row['product_name']} {row.get('size', '')}".strip(),
                    brand=(row.get("brand") or "").strip() or None,
                    size=(row.get("size") or "").strip() or None,
                    price=price, observed_at=when, source="verified_manual",
                    source_detail=f"checked by {row.get('checked_by') or 'team'}",
                    url=(row.get("source_url") or "").strip() or None,
                ))
        return out


# ---------------------------------------------------------------------------
# RapidAPI "South African Grocery Prices API" — third party, UNTESTED
# ---------------------------------------------------------------------------


class RapidApiSaGroceryProvider:
    """
    The third-party "South African Grocery Prices API" listed on RapidAPI
    (Pick n Pay, Checkers, Woolworths). Its listing documents
        GET /v1/{store}/products?page=1&limit=50
    with an x-rapidapi-key header. Its response fields and its search
    parameter are NOT documented publicly, and this code has never been run
    against the live service (the sandbox it was written in had no network).

    So everything uncertain is configuration, and the parser accepts the
    common shapes. BEFORE relying on it, run:

        python -m app.price_feed probe --store checkers --query "maize meal"

    and check (1) the store slugs, (2) that the search parameter filters,
    (3) that the printed name/price/size look right. Then set:

        RAPIDAPI_KEY=...                       (required)
        PRICE_API_HOST=south-african-grocery-prices-api.p.rapidapi.com
        PRICE_API_PATH=/v1/{store}/products
        PRICE_API_SEARCH_PARAM=search          (whatever probe shows works)
        PRICE_API_STORE_MAP={"checkers": "checkers", "picknpay": "pnp"}
                                               (our external_store_id -> their slug)
    """

    name = "live_api"
    DEFAULT_HOST = "south-african-grocery-prices-api.p.rapidapi.com"

    def __init__(self, key=None, host=None, path=None, search_param=None, store_map=None,
                 timeout=15, max_requests=120, opener=None):
        self.key = key or os.getenv("RAPIDAPI_KEY")
        self.host = host or os.getenv("PRICE_API_HOST", self.DEFAULT_HOST)
        self.path = path or os.getenv("PRICE_API_PATH", "/v1/{store}/products")
        self.search_param = search_param or os.getenv("PRICE_API_SEARCH_PARAM", "search")
        raw_map = store_map or os.getenv("PRICE_API_STORE_MAP") or '{"checkers": "checkers", "picknpay": "pnp"}'
        self.store_map = raw_map if isinstance(raw_map, dict) else json.loads(raw_map)
        self.timeout = timeout
        self.max_requests = max_requests
        self.requests_made = 0
        self._open = opener or urllib.request.urlopen

    @property
    def configured(self) -> bool:
        return bool(self.key)

    def covered_stores(self) -> List[str]:
        return sorted(self.store_map)

    def get(self, store_slug: str, params: dict) -> object:
        if not self.key:
            raise RuntimeError("RAPIDAPI_KEY is not set — see app/price_feed/providers.py")
        if self.requests_made >= self.max_requests:
            raise RuntimeError(f"stopped after {self.max_requests} requests (max_requests)")
        url = (f"https://{self.host}{self.path.format(store=urllib.parse.quote(store_slug))}"
               f"?{urllib.parse.urlencode(params)}")
        request = urllib.request.Request(url, headers={
            "x-rapidapi-key": self.key, "x-rapidapi-host": self.host, "Accept": "application/json",
        })
        self.requests_made += 1
        with self._open(request, timeout=self.timeout) as response:
            return json.loads(response.read().decode("utf-8"))

    def search(self, store_key: str, query: str, limit: int = 20) -> List[LivePrice]:
        slug = self.store_map.get(store_key)
        if not slug:
            return []
        payload = self.get(slug, {self.search_param: query, "page": 1, "limit": limit})
        return parse_listings(payload, store_key, source_detail=f"rapidapi:{slug}")

    def fetch_for(self, wanted: Sequence[tuple]) -> List[LivePrice]:
        """wanted: (store_key, search text) pairs — one request each."""
        out: List[LivePrice] = []
        for store_key, query in wanted:
            out.extend(self.search(store_key, query))
        return out


_LIST_KEYS = ("data", "products", "results", "result", "items", "hits", "response")
_NAME_KEYS = ("name", "title", "product_name", "productName", "description")
_PRICE_KEYS = ("price", "current_price", "currentPrice", "sale_price", "salePrice",
               "selling_price", "price_zar", "amount")
_WAS_KEYS = ("was_price", "wasPrice", "regular_price", "regularPrice", "original_price")
_URL_KEYS = ("url", "product_url", "productUrl", "link")
_BRAND_KEYS = ("brand", "brand_name", "brandName")
_SIZE_KEYS = ("size", "unit_size", "unitSize", "weight", "volume", "pack_size")


def _first(d: dict, keys: Iterable[str]):
    for k in keys:
        if k in d and d[k] not in (None, ""):
            return d[k]
    return None


def _find_list(payload):
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in _LIST_KEYS:
            value = payload.get(key)
            if isinstance(value, list):
                return value
            if isinstance(value, dict):
                inner = _find_list(value)
                if inner:
                    return inner
        # Last resort: the only list of objects anywhere at the top level.
        lists = [v for v in payload.values() if isinstance(v, list) and v and isinstance(v[0], dict)]
        if len(lists) == 1:
            return lists[0]
    return []


def parse_listings(payload, store_key: str, source_detail: str = "live api",
                   now: Optional[datetime] = None) -> List[LivePrice]:
    """Accept the common JSON shapes; skip anything without a name and a price."""
    now = now or datetime.now(timezone.utc)
    out = []
    for item in _find_list(payload):
        if not isinstance(item, dict):
            continue
        name = _first(item, _NAME_KEYS)
        raw_price = _first(item, _PRICE_KEYS)
        if isinstance(raw_price, dict):                    # {"amount": 19.99, "currency": "ZAR"}
            raw_price = _first(raw_price, ("amount", "value", "price"))
        price = parse_price(raw_price)
        if not name or price is None or price <= 0:
            continue
        was = parse_price(_first(item, _WAS_KEYS))
        size = _first(item, _SIZE_KEYS)
        out.append(LivePrice(
            store_key=store_key, title=str(name), price=price, observed_at=now,
            source="live_api", source_detail=source_detail,
            brand=_first(item, _BRAND_KEYS), size=str(size) if size is not None else None,
            url=_first(item, _URL_KEYS),
            on_promotion=bool(was and was > price) or bool(item.get("on_promotion") or item.get("promo")),
        ))
    return out
