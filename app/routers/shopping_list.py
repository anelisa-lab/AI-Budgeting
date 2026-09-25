"""
Shopping list — /shopping-list (Phase 5).

Until Phase 5 the list lived in each browser's localStorage, so it did not
follow a student to another phone or computer. It is now stored per student in
comparison_lists / comparison_items (in the schema since Phase 1, unused until
now): one list per student, one line per offer, with a quantity and the price
the offer had when it was added.

Every call returns the whole list, with each line joined to today's offer
(current price, stock, delivery fee), so the screens never work from a stale
copy. POST adds to a line's quantity; PUT sets it; quantities are clamped to
1..MAX_QTY like the frontend's stepper.
"""

from fastapi import APIRouter, Depends, HTTPException

from app.database import get_connection
from app.dependencies import get_current_user_id
from app.schemas import ShoppingListItemIn, ShoppingListOut, ShoppingListQtyIn

router = APIRouter(prefix="/shopping-list", tags=["shopping-list"])

MAX_QTY = 20
LIST_NAME = "Shopping list"

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


def _read(cur, list_id: int) -> ShoppingListOut:
    cur.execute(_LINES_SQL, (list_id,))
    return ShoppingListOut(items=cur.fetchall())


def _clamp(qty: int) -> int:
    return max(1, min(MAX_QTY, qty))


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
    """Add an offer, or add to its quantity if it is already on the list."""
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT price FROM product_offers WHERE id = %s", (payload.offer_id,))
            offer = cur.fetchone()
            if not offer:
                raise HTTPException(status_code=404, detail="That item is no longer listed.")
            list_id = _list_id(cur, user_id)
            cur.execute(
                """INSERT INTO comparison_items (comparison_list_id, offer_id, qty, price_when_added)
                   VALUES (%s, %s, %s, %s)
                   ON CONFLICT (comparison_list_id, offer_id) DO UPDATE
                   SET qty = LEAST(comparison_items.qty + EXCLUDED.qty, %s)""",
                (list_id, payload.offer_id, _clamp(payload.qty), offer["price"], MAX_QTY),
            )
            cur.execute("UPDATE comparison_lists SET updated_at = NOW() WHERE id = %s", (list_id,))
            return _read(cur, list_id)
    finally:
        conn.close()


@router.put("/items/{offer_id}", response_model=ShoppingListOut)
def set_quantity(offer_id: int, payload: ShoppingListQtyIn, user_id: int = Depends(get_current_user_id)):
    """Set a line's quantity. 0 removes it."""
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            list_id = _list_id(cur, user_id)
            if payload.qty <= 0:
                cur.execute(
                    "DELETE FROM comparison_items WHERE comparison_list_id = %s AND offer_id = %s",
                    (list_id, offer_id),
                )
            else:
                cur.execute(
                    "UPDATE comparison_items SET qty = %s WHERE comparison_list_id = %s AND offer_id = %s",
                    (_clamp(payload.qty), list_id, offer_id),
                )
                if cur.rowcount == 0:
                    raise HTTPException(status_code=404, detail="That item is not on your list.")
            return _read(cur, list_id)
    finally:
        conn.close()


@router.delete("/items/{offer_id}", response_model=ShoppingListOut)
def remove_item(offer_id: int, user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            list_id = _list_id(cur, user_id)
            cur.execute(
                "DELETE FROM comparison_items WHERE comparison_list_id = %s AND offer_id = %s",
                (list_id, offer_id),
            )
            return _read(cur, list_id)
    finally:
        conn.close()


@router.delete("", response_model=ShoppingListOut)
def clear_list(user_id: int = Depends(get_current_user_id)):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            list_id = _list_id(cur, user_id)
            cur.execute("DELETE FROM comparison_items WHERE comparison_list_id = %s", (list_id,))
            return _read(cur, list_id)
    finally:
        conn.close()
