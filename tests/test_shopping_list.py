"""
Shopping list with live store items (app/routers/shopping_list.py, sql/009).

The summary test needs no database. The route tests run only when
TEST_DATABASE_URL points at a throwaway Postgres database: they load
sql/schema.sql (idempotent) and call the route functions directly, as the
logged-in user, against that database.
"""

import os
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.routers import shopping_list as sl
from app.schemas import ShoppingListItemIn, ShoppingListQtyIn

D = Decimal
DB_URL = os.getenv("TEST_DATABASE_URL")
NOW = datetime(2026, 9, 28, tzinfo=timezone.utc)


def _offer_line(price, qty, current=None, availability="available"):
    return {"price": D(price), "current_price": D(current or price), "qty": qty,
            "availability_status": availability}


def _live(price, qty, current=None, in_stock=True):
    row = {"price": D(price), "current_price": None if current == "none" else D(current or price),
           "in_stock": in_stock, "qty": qty}
    return sl._live_line(row)


def test_total_uses_saved_prices_and_skips_unbuyable_lines():
    summary = sl.summarise(
        [_offer_line("20.00", 2), _offer_line("9.99", 1, availability="out_of_stock"),
         _offer_line("5.00", 1, current="0.00")],
        [_live("18.99", 3, current="19.99"),                 # price went up: total keeps 18.99
         _live("26.99", 1, current="none", in_stock=False)],  # out of stock now: not counted
    )
    assert summary["total"] == D("96.97")                    # 2 x 20 + 3 x 18.99
    assert summary["count"] == 8
    assert summary["unavailable_count"] == 3
    assert summary["changed_count"] == 1


# ------------------------------------------------------------------ routes


@pytest.fixture
def db(monkeypatch):
    if not DB_URL:
        pytest.skip("set TEST_DATABASE_URL to run the shopping list route tests")
    import psycopg2
    import psycopg2.extras

    def connect():
        return psycopg2.connect(DB_URL, cursor_factory=psycopg2.extras.RealDictCursor)

    conn = connect()
    root = Path(__file__).parent.parent / "sql"
    with conn.cursor() as cur:
        for name in ("schema.sql", "008_live_items_missing_price.sql",
                     "009_shopping_list_live_items.sql"):
            cur.execute((root / name).read_text())
        cur.execute("TRUNCATE comparison_items, comparison_lists, items RESTART IDENTITY CASCADE")
        cur.execute("DELETE FROM users WHERE email LIKE '%@list.test'")
        ids = []
        for who in ("a", "b"):
            cur.execute("""INSERT INTO users (name, email, password_hash)
                           VALUES (%s, %s, 'x') RETURNING id""", (who, f"{who}@list.test"))
            ids.append(cur.fetchone()["id"])
        cur.execute("""INSERT INTO items (store, sku, name, price, last_known_price, in_stock, image_url)
                       VALUES ('Checkers', '10136301', 'Albany Superior White Bread 700g', 18.99, 18.99, TRUE, 'https://img/a'),
                              ('Checkers', '10500001', 'Pride Red Speckled Beans 2kg', NULL, NULL, FALSE, NULL),
                              ('Pick n Pay', 'p1', 'PnP Bread', 15.99, 15.99, TRUE, NULL)
                       RETURNING id""")
        items = [r["id"] for r in cur.fetchall()]
    conn.commit()
    monkeypatch.setattr(sl, "get_connection", connect)
    monkeypatch.setenv("LIVE_PRICE_STORES", "checkers")
    yield {"conn": conn, "user": ids[0], "other": ids[1],
           "bread": items[0], "beans": items[1], "pnp": items[2]}
    conn.close()


def _add(db, item, qty=1, user=None):
    return sl.add_item(ShoppingListItemIn(item_id=item, qty=qty), user_id=user or db["user"])


def test_add_then_add_again_increments_one_line(db):
    out = _add(db, db["bread"])
    [line] = out.live_items
    assert (line.name, line.store, line.qty, line.price) == \
        ("Albany Superior White Bread 700g", "Checkers", 1, D("18.99"))
    assert line.image_url == "https://img/a"

    out = _add(db, db["bread"], qty=2)
    assert [(l.item_id, l.qty) for l in out.live_items] == [(db["bread"], 3)]   # no duplicate
    assert out.summary.total == D("56.97") and out.summary.count == 3


def test_saved_price_is_kept_when_the_live_price_changes(db):
    _add(db, db["bread"], qty=2)
    with db["conn"].cursor() as cur:
        cur.execute("UPDATE items SET price = 19.99 WHERE id = %s", (db["bread"],))
    db["conn"].commit()
    [line] = sl.get_list(user_id=db["user"]).live_items
    assert (line.price, line.current_price, line.price_changed) == (D("18.99"), D("19.99"), True)
    assert line.line_total == D("37.98")                      # the saved price, not 19.99


def test_out_of_stock_or_unpriced_can_never_be_added(db):
    with pytest.raises(HTTPException) as err:
        _add(db, db["beans"])
    assert err.value.status_code == 409
    assert sl.get_list(user_id=db["user"]).live_items == []


def test_switched_off_store_cannot_be_added(db):
    with pytest.raises(HTTPException) as err:
        _add(db, db["pnp"])
    assert err.value.status_code == 409 and "switched off" in err.value.detail


def test_item_that_goes_out_of_stock_leaves_the_total(db):
    _add(db, db["bread"])
    with db["conn"].cursor() as cur:
        cur.execute("UPDATE items SET price = NULL, in_stock = FALSE WHERE id = %s", (db["bread"],))
    db["conn"].commit()
    out = sl.get_list(user_id=db["user"])
    assert out.live_items[0].buyable is False
    assert out.summary.total == D("0.00") and out.summary.unavailable_count == 1


def test_change_quantity_remove_and_clear(db):
    _add(db, db["bread"])
    out = sl.set_live_quantity(db["bread"], ShoppingListQtyIn(qty=4), user_id=db["user"])
    assert out.live_items[0].qty == 4 and out.summary.total == D("75.96")
    out = sl.remove_live_item(db["bread"], user_id=db["user"])
    assert out.live_items == [] and out.summary.total == D("0.00")

    _add(db, db["bread"])
    out = sl.set_live_quantity(db["bread"], ShoppingListQtyIn(qty=0), user_id=db["user"])  # 0 removes
    assert out.live_items == []

    _add(db, db["bread"])
    assert sl.clear_list(user_id=db["user"]).summary.count == 0


def test_each_user_sees_only_their_own_list(db):
    _add(db, db["bread"], qty=2)
    assert sl.get_list(user_id=db["other"]).live_items == []
    with pytest.raises(HTTPException) as err:
        sl.set_live_quantity(db["bread"], ShoppingListQtyIn(qty=5), user_id=db["other"])
    assert err.value.status_code == 404
    assert sl.get_list(user_id=db["user"]).live_items[0].qty == 2


def test_request_needs_exactly_one_product():
    with pytest.raises(ValueError):
        ShoppingListItemIn(qty=1)
    with pytest.raises(ValueError):
        ShoppingListItemIn(offer_id=1, item_id=2)
