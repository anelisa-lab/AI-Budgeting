"""
Shopping list — /shopping-list (Phase 5).

Until Phase 5 the list lived in each browser's localStorage, so it did not
follow a student to another phone or computer. It is now stored per student in
comparison_lists / comparison_items (in the schema since Phase 1, unused until
now): one list per student, one line per offer, with a quantity and the price
the offer had when it was added.

Every call returns the whole list, with each line joined to today's offer
(current price, stock, delivery fee), so the screens never work from a stale
copy. POST adds to a line's quantity; PUT/PATCH sets it; quantities are
clamped to 1..MAX_QTY like the frontend's stepper.

Live store items (Checkers Sixty60, GET /api/search) can go on the same list
(sql/009): POST {item_id}, PUT/PATCH/DELETE /live-items/{item_id}. Every
response carries a summary whose total uses the price SAVED when each item
was added — today's price is shown beside it, never silently swapped in — and
leaves out anything that can't be bought right now.
"""

from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from app.database import get_connection
from app.dependencies import get_current_user_id
from app.schemas import ShoppingListItemIn, ShoppingListOut, ShoppingListQtyIn
from app.scrapers import active_stores, store_name

router = APIRouter(prefix="/shopping-list", tags=["shopping-list"])

MAX_QTY = 20
LIST_NAME = "Shopping list"
CENT = Decimal("0.01")

_LINES_SQL = """
    SELECT o.id AS offer_id, p.id AS product_id, p.name AS product_name, p.brand,
           p.size, p.category, p.is_essential,
           s.id AS store_id, s.name AS store_name, s.store_type,
           COALESCE(ci.price_when_added, o.price) AS price,
           o.price AS current_price, o.shipping_cost, o.total_cost,
           o.availability_status, ci.qty, ci.added_at
    FROM comparison_items ci
    JOIN product_offers o ON o.id = ci.offer_id
    JOIN products p ON p.id = o.product_id
    JOIN stores s ON s.id = o.store_id
    WHERE ci.comparison_list_id = %s
    ORDER BY ci.added_at, o.id
"""

# Live store items (GET /api/search) on the list. price is what it cost when
# added; current_price is today's (NULL when the store has no price now).
_LIVE_LINES_SQL = """
    SELECT i.id AS item_id, i.name, i.store, i.brand, i.image_url, i.product_url,
           ci.price_when_added AS price, i.price AS current_price, i.in_stock,
           ci.qty, ci.added_at
    FROM comparison_items ci
    JOIN items i ON i.id = ci.item_id
    WHERE ci.comparison_list_id = %s
    ORDER BY ci.added_at, ci.id
"""


def _list_id(cur, user_id: int) -> int:
    """The student's list, created on first use."""
    cur.execute(
        "SELECT id FROM comparison_lists WHERE user_id = %s ORDER BY id LIMIT 1", (user_id,)
    )
    row = cur.fetchone()
    if row:
        return row["id"]
    cur.execute(
        "INSERT INTO comparison_lists (user_id, name) VALUES (%s, %s) RETURNING id",
        (user_id, LIST_NAME),
    )
    return cur.fetchone()["id"]


def _live_line(row: dict) -> dict:
    current: Optional[Decimal] = row["current_price"]
    buyable = bool(row["in_stock"]) and current is not None and current > 0
    return {
        **row,
        "buyable": buyable,
        "price_changed": buyable and current != row["price"],
        "line_total": (row["price"] * row["qty"]).quantize(CENT),
    }


def summarise(offer_lines, live_lines) -> dict:
    """
    The list total at SAVED prices, counting only lines that can still be
    bought (in stock, with a real price today). Pure — unit-tested.
    """
    total, count, unavailable, changed = Decimal("0"), 0, 0, 0
    for line in offer_lines:
        count += line["qty"]
        if line["availability_status"] == "available" and line["current_price"] > 0:
            total += line["price"] * line["qty"]
            changed += line["current_price"] != line["price"]
        else:
            unavailable += 1
    for line in live_lines:
        count += line["qty"]
        if line["buyable"]:
            total += line["price"] * line["qty"]
            changed += line["price_changed"]
        else:
            unavailable += 1
    return {"total": total.quantize(CENT), "count": count,
            "unavailable_count": unavailable, "changed_count": int(changed)}


def _read(cur, list_id: int) -> ShoppingListOut:
    cur.execute(_LINES_SQL, (list_id,))
    offer_lines = cur.fetchall()
    cur.execute(_LIVE_LINES_SQL, (list_id,))
    live_lines = [_live_line(r) for r in cur.fetchall()]
    return ShoppingListOut(items=offer_lines, live_items=live_lines,
                           summary=summarise(offer_lines, live_lines))


def _clamp(qty: int) -> int:
    return max(1, min(MAX_QTY, qty))


def _touch(cur, list_id: int) -> None:
    cur.execute("UPDATE comparison_lists SET updated_at = NOW() WHERE id = %s", (list_id,))


@router.get("", response_model=ShoppingListOut)
def get_list(user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            return _read(cur, _list_id(cur, user_id))
    finally:
        conn.close()


@router.post("/items", response_model=ShoppingListOut)
def add_item(payload: ShoppingListItemIn, user_id: int = Depends(get_current_user_id)):
    """
    Add a catalogue offer ({offer_id}) or a live store item ({item_id}), or
    add to its quantity if it is already on the list. The unit price is saved
    at the moment it is first added. Out of stock / no price: 409, never added.
    """
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            if payload.item_id is not None:
                price, column, product_id = _live_item_price(cur, payload.item_id), "item_id", payload.item_id
            else:
                price, column, product_id = _offer_price(cur, payload.offer_id), "offer_id", payload.offer_id
            list_id = _list_id(cur, user_id)
            cur.execute(
                f"""INSERT INTO comparison_items (comparison_list_id, {column}, qty, price_when_added)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (comparison_list_id, {column}) DO UPDATE
                    SET qty = LEAST(comparison_items.qty + EXCLUDED.qty, %s)""",
                (list_id, product_id, _clamp(payload.qty), price, MAX_QTY),
            )
            _touch(cur, list_id)
            return _read(cur, list_id)
    finally:
        conn.close()


def _offer_price(cur, offer_id: int) -> Decimal:
    cur.execute("SELECT price, availability_status FROM product_offers WHERE id = %s", (offer_id,))
    offer = cur.fetchone()
    if not offer:
        raise HTTPException(status_code=404, detail="That item is no longer listed.")
    # Only something you can buy goes into a list total: never an
    # out-of-stock offer, never an unknown (0) price.
    if offer["availability_status"] != "available" or offer["price"] <= 0:
        raise HTTPException(status_code=409,
                            detail="That item is out of stock or has no price right now.")
    return offer["price"]


def _live_item_price(cur, item_id: int) -> Decimal:
    cur.execute("SELECT price, in_stock, store FROM items WHERE id = %s", (item_id,))
    item = cur.fetchone()
    if not item:
        raise HTTPException(status_code=404, detail="That product is no longer listed.")
    if item["store"] not in {store_name(s) for s in active_stores()}:
        raise HTTPException(status_code=409, detail=f"Live prices from {item['store']} are switched off.")
    if not item["in_stock"] or item["price"] is None or item["price"] <= 0:
        raise HTTPException(status_code=409,
                            detail="That item is out of stock or has no price right now.")
    return item["price"]


def _set_qty(user_id: int, column: str, product_id: int, qty: int) -> ShoppingListOut:
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            list_id = _list_id(cur, user_id)
            if qty <= 0:
                cur.execute(
                    f"DELETE FROM comparison_items WHERE comparison_list_id = %s AND {column} = %s",
                    (list_id, product_id),
                )
            else:
                cur.execute(
                    f"UPDATE comparison_items SET qty = %s WHERE comparison_list_id = %s AND {column} = %s",
                    (_clamp(qty), list_id, product_id),
                )
                if cur.rowcount == 0:
                    raise HTTPException(status_code=404, detail="That item is not on your list.")
            _touch(cur, list_id)
            return _read(cur, list_id)
    finally:
        conn.close()


def _remove(user_id: int, column: str, product_id: int) -> ShoppingListOut:
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            list_id = _list_id(cur, user_id)
            cur.execute(
                f"DELETE FROM comparison_items WHERE comparison_list_id = %s AND {column} = %s",
                (list_id, product_id),
            )
            _touch(cur, list_id)
            return _read(cur, list_id)
    finally:
        conn.close()


# Catalogue offers — /items/{offer_id}. PUT and PATCH both set the quantity.
@router.put("/items/{offer_id}", response_model=ShoppingListOut)
@router.patch("/items/{offer_id}", response_model=ShoppingListOut)
def set_quantity(offer_id: int, payload: ShoppingListQtyIn, user_id: int = Depends(get_current_user_id)):
    """Set a line's quantity. 0 removes it."""
    return _set_qty(user_id, "offer_id", offer_id, payload.qty)


@router.delete("/items/{offer_id}", response_model=ShoppingListOut)
def remove_item(offer_id: int, user_id: int = Depends(get_current_user_id)):
    return _remove(user_id, "offer_id", offer_id)


# Live store items — /live-items/{item_id}
@router.put("/live-items/{item_id}", response_model=ShoppingListOut)
@router.patch("/live-items/{item_id}", response_model=ShoppingListOut)
def set_live_quantity(item_id: int, payload: ShoppingListQtyIn, user_id: int = Depends(get_current_user_id)):
    """Set a live item's quantity. 0 removes it."""
    return _set_qty(user_id, "item_id", item_id, payload.qty)


@router.delete("/live-items/{item_id}", response_model=ShoppingListOut)
def remove_live_item(item_id: int, user_id: int = Depends(get_current_user_id)):
    return _remove(user_id, "item_id", item_id)


@router.delete("", response_model=ShoppingListOut)
def clear_list(user_id: int = Depends(get_current_user_id)):
    """Empty the whole list — catalogue and live items."""
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            list_id = _list_id(cur, user_id)
            cur.execute("DELETE FROM comparison_items WHERE comparison_list_id = %s", (list_id,))
            _touch(cur, list_id)
            return _read(cur, list_id)
    finally:
        conn.close()
