"""
app/live_items.py. The row-building tests need no database; the upsert test
runs only when TEST_DATABASE_URL points at a throwaway Postgres database
(it creates the items table from sql/006_live_items.sql and empties it).
"""

import os
from decimal import Decimal
from pathlib import Path

import pytest

from app.live_items import _to_row, upsert_items

BREAD = {"name": "Albany Superior White Bread 700g", "price": 18.99, "sku": "10136301",
         "image_url": "https://img/a", "product_url": "https://www.checkers.co.za/product/a-10136301EA",
         "brand": "Albany", "on_promotion": False, "in_stock": True, "store": "Checkers"}


def test_row_from_scraper_output():
    assert _to_row(BREAD) == ("Checkers", "10136301", "Albany Superior White Bread 700g",
                              Decimal("18.99"), "https://img/a",
                              "https://www.checkers.co.za/product/a-10136301EA",
                              "Albany", None, False, True, Decimal("18.99"))


def test_product_url_is_the_key_when_there_is_no_sku():
    assert _to_row({**BREAD, "sku": None})[1] == BREAD["product_url"]


@pytest.mark.parametrize("bad", [{"store": ""}, {"sku": None, "product_url": None},
                                 {"name": " "}])
def test_unsaveable_products_are_rejected(bad):
    assert _to_row({**BREAD, **bad}) is None


@pytest.mark.parametrize("no_price", [{"price": None}, {"price": 0}, {"price": "0.00"},
                                      {"price": "abc"}, {"price": -1}, {"price": True},
                                      {"in_stock": False}])
def test_missing_price_is_saved_as_null_never_zero(no_price):
    row = _to_row({**BREAD, **no_price})
    assert row is not None
    assert row[3] is None and row[10] is None          # price, last_known_price


DB_URL = os.getenv("TEST_DATABASE_URL")


@pytest.fixture
def conn():
    if not DB_URL:
        pytest.skip("set TEST_DATABASE_URL to run the Postgres upsert test")
    import psycopg2
    import psycopg2.extras
    c = psycopg2.connect(DB_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    with c.cursor() as cur:
        cur.execute((Path(__file__).parent.parent / "sql/006_live_items.sql").read_text())
        cur.execute((Path(__file__).parent.parent / "sql/008_live_items_missing_price.sql").read_text())
        cur.execute("TRUNCATE items RESTART IDENTITY CASCADE")
    c.commit()
    yield c
    c.close()


def _rows(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT sku, price, category, on_promotion, last_updated FROM items")
        return {r["sku"]: r for r in cur.fetchall()}


def test_upsert_inserts_then_updates_in_place(conn):
    brown = {**BREAD, "sku": "2", "name": "Brown", "price": 16.49}
    first = upsert_items(conn, [BREAD, brown, {**BREAD, "price": None}])
    assert len(first) == 2

    with conn.cursor() as cur:
        cur.execute("UPDATE items SET category = 'Bakery', "
                    "last_updated = NOW() - INTERVAL '1 day' WHERE sku = %s", (BREAD["sku"],))
    conn.commit()

    again = upsert_items(conn, [{**BREAD, "price": 15.99, "on_promotion": True}, brown, brown])
    assert again == first                                      # same rows, not new ones
    rows = _rows(conn)
    bread, brown_row = rows[BREAD["sku"]], rows["2"]
    assert (bread["price"], bread["category"], bread["on_promotion"]) == \
        (Decimal("15.99"), "Bakery", True)                     # category kept
    assert bread["last_updated"] == brown_row["last_updated"]  # both stamped by this upsert
    assert len(rows) == 2


def test_upsert_nothing(conn):
    assert upsert_items(conn, []) == []


def test_out_of_stock_keeps_last_known_price(conn):
    [item_id] = upsert_items(conn, [BREAD])
    upsert_items(conn, [{**BREAD, "price": 0, "in_stock": False}])     # now out of stock
    with conn.cursor() as cur:
        cur.execute("SELECT price, last_known_price, last_priced_at, in_stock FROM items WHERE id = %s",
                    (item_id,))
        row = cur.fetchone()
    assert row["price"] is None                        # no current price — not R0
    assert row["last_known_price"] == Decimal("18.99")  # the real price is kept
    assert row["last_priced_at"] is not None and row["in_stock"] is False

    upsert_items(conn, [{**BREAD, "price": 19.99}])    # back in stock at a new price
    with conn.cursor() as cur:
        cur.execute("SELECT price, last_known_price, in_stock FROM items WHERE id = %s", (item_id,))
        assert tuple(cur.fetchone().values()) == (Decimal("19.99"), Decimal("19.99"), True)


def test_database_refuses_a_zero_price(conn):
    import psycopg2
    with conn.cursor() as cur, pytest.raises(psycopg2.errors.CheckViolation):
        cur.execute("INSERT INTO items (store, sku, name, price) VALUES ('Checkers', 'z', 'Zero', 0)")
    conn.rollback()
