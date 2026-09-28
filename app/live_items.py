"""
Saving live store search results (app/scrapers) into the `items` table.

    from app.live_items import upsert_items
    ids = upsert_items(conn, search_checkers("bread"))

One row per (store, sku): a product seen again gets its name, price, image,
URL and flags overwritten and last_updated set to NOW(). category is only
overwritten when the scraper supplies one, so a category set by hand (or by
a later classifier) survives the next price refresh.

A missing price is NULL, never 0. `price` is what the store charges right
now (NULL when it has no price, e.g. out of stock); `last_known_price` is the
last real price seen and is never overwritten by a missing one, so an
out-of-stock product keeps "last seen R18.99" while in_stock goes false.

Tables: sql/006_live_items.sql, sql/008_live_items_missing_price.sql.
"""

from __future__ import annotations

import logging
from decimal import Decimal, InvalidOperation
from typing import Dict, Iterable, List, Optional, Tuple

import psycopg2.extras

log = logging.getLogger(__name__)

_COLUMNS = ("store", "sku", "name", "price", "image_url", "product_url",
            "brand", "category", "on_promotion", "in_stock", "last_known_price")

_UPSERT_SQL = f"""
    INSERT INTO items ({", ".join(_COLUMNS)}, last_priced_at, last_updated)
    VALUES %s
    ON CONFLICT (store, sku) DO UPDATE SET
      name         = EXCLUDED.name,
      price        = EXCLUDED.price,
      last_known_price = COALESCE(EXCLUDED.price, items.last_known_price),
      last_priced_at   = CASE WHEN EXCLUDED.price IS NULL THEN items.last_priced_at
                              ELSE NOW() END,
      image_url    = EXCLUDED.image_url,
      product_url  = EXCLUDED.product_url,
      brand        = EXCLUDED.brand,
      category     = COALESCE(EXCLUDED.category, items.category),
      on_promotion = EXCLUDED.on_promotion,
      in_stock     = EXCLUDED.in_stock,
      last_updated = NOW()
    RETURNING id, store, sku
"""


def upsert_items(conn, products: Iterable[dict], commit: bool = True) -> List[int]:
    """
    Insert or update scraper results. Returns the items.id of each saved
    product, in the order given (products that couldn't be saved — no
    store, key or name — are logged and left out). A product without a
    usable price is still saved, with price NULL.
    """
    rows: Dict[Tuple[str, str], tuple] = {}
    for product in products:
        row = _to_row(product)
        if row is None:
            log.warning("not saving live item without store/sku/name: %.200r", product)
            continue
        rows[(row[0], row[1])] = row      # a product listed twice: keep the last one

    if not rows:
        return []
    with conn.cursor() as cur:
        returned = psycopg2.extras.execute_values(
            cur, _UPSERT_SQL, [row + (row[3],) for row in rows.values()],
            template=(f"({', '.join(['%s'] * len(_COLUMNS))}, "
                      "CASE WHEN %s::numeric IS NULL THEN NULL ELSE NOW() END, NOW())"),
            page_size=len(rows), fetch=True,
        )
    if commit:
        conn.commit()
    ids = {(_get(r, 1), _get(r, 2)): _get(r, 0) for r in returned}
    return [ids[key] for key in rows]


def _to_row(p: dict) -> Optional[tuple]:
    store = (p.get("store") or "").strip()
    # sku is the unique key; product_url stands in for a scraper that has no code
    sku = str(p.get("sku") or p.get("product_url") or "").strip()
    name = (p.get("name") or "").strip()
    if not (store and sku and name):
        return None
    in_stock = bool(p.get("in_stock", True))
    price = _price(p.get("price")) if in_stock else None     # out of stock: no current price
    return (store, sku, name, price, p.get("image_url"), p.get("product_url"),
            p.get("brand"), p.get("category"),
            bool(p.get("on_promotion", False)), in_stock, price)


def _price(value) -> Optional[Decimal]:
    """A real, positive price — or None. 0, negatives and junk are never a price."""
    if value is None or isinstance(value, bool):
        return None
    try:
        price = Decimal(str(value)).quantize(Decimal("0.01"))
    except InvalidOperation:
        return None
    return price if price > 0 else None


def _get(row, i):
    """RETURNING rows are dicts with the app's RealDictCursor, tuples otherwise."""
    return list(row.values())[i] if isinstance(row, dict) else row[i]
