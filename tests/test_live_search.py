"""
app/live_search.py cache rules, with a fake scraper. The DB tests need
Postgres: they run only when TEST_DATABASE_URL points at a throwaway
database (they create the live tables from sql/006 + sql/007 and empty them).
"""

import os
from pathlib import Path

import pytest

from app import live_search

DB_URL = os.getenv("TEST_DATABASE_URL")
SQL = Path(__file__).parent.parent / "sql"


def test_normalise_query():
    assert live_search.normalise_query("  Brown   BREAD ") == "brown bread"


def test_ttl_from_env(monkeypatch):
    monkeypatch.setenv("LIVE_SEARCH_TTL_HOURS", "2")
    assert live_search.cache_ttl().total_seconds() == 7200
    monkeypatch.setenv("LIVE_SEARCH_TTL_HOURS", "junk")
    assert live_search.cache_ttl().total_seconds() == 6 * 3600


@pytest.fixture
def conn():
    if not DB_URL:
        pytest.skip("set TEST_DATABASE_URL to run the live search cache tests")
    import psycopg2
    import psycopg2.extras
    c = psycopg2.connect(DB_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    with c.cursor() as cur:
        cur.execute((SQL / "006_live_items.sql").read_text())
        cur.execute((SQL / "007_live_search_cache.sql").read_text())
        cur.execute((SQL / "008_live_items_missing_price.sql").read_text())
        cur.execute("TRUNCATE items, live_searches, live_search_results RESTART IDENTITY CASCADE")
    c.commit()
    yield c
    c.close()


def _product(sku, price=10.0):
    return {"name": f"Bread {sku}", "price": price, "sku": sku, "store": "Checkers",
            "image_url": f"https://img/{sku}", "product_url": f"https://p/{sku}"}


class FakeStore:
    def __init__(self, products):
        self.products, self.calls = products, []

    def __call__(self, store, query):
        self.calls.append((store, query))
        return list(self.products)


def _age(conn, hours):
    with conn.cursor() as cur:
        cur.execute("UPDATE live_searches SET searched_at = NOW() - %s * INTERVAL '1 hour'", (hours,))
    conn.commit()


def test_miss_then_hit_then_refresh(conn):
    fake = FakeStore([_product("b"), _product("a")])
    [first] = live_search.search(conn, "Bread", scrape=fake, stores=["checkers"])
    assert first.source == "live"
    assert [i["name"] for i in first.items] == ["Bread b", "Bread a"]     # store's order kept

    [second] = live_search.search(conn, " bread ", scrape=fake, stores=["checkers"])
    assert second.source == "cache" and len(fake.calls) == 1               # store not asked again
    assert [i["id"] for i in second.items] == [i["id"] for i in first.items]

    _age(conn, 7)                                                          # older than 6h
    fake.products = [_product("a", 12.5)]
    [third] = live_search.search(conn, "bread", scrape=fake, stores=["checkers"])
    assert third.source == "live" and len(fake.calls) == 2
    assert [(i["name"], float(i["price"])) for i in third.items] == [("Bread a", 12.5)]


def test_store_down_serves_stale_then_unavailable(conn):
    live_search.search(conn, "bread", scrape=FakeStore([_product("a")]), stores=["checkers"])
    _age(conn, 7)
    [stale] = live_search.search(conn, "bread", scrape=FakeStore([]), stores=["checkers"])
    assert stale.source == "stale" and [i["name"] for i in stale.items] == ["Bread a"]

    [none] = live_search.search(conn, "milk", scrape=FakeStore([]), stores=["checkers"])
    assert none.source == "unavailable" and none.items == []
    with conn.cursor() as cur:                                             # empty answer not cached
        cur.execute("SELECT COUNT(*) AS n FROM live_searches WHERE query = 'milk'")
        assert cur.fetchone()["n"] == 0


def test_other_stores_rows_never_come_back(conn, caplog):
    # A scraper that returns another store's row: it is dropped, not saved
    mixed = FakeStore([_product("a"), {**_product("pnp"), "store": "Pick n Pay"}])
    [result] = live_search.search(conn, "bread", scrape=mixed, stores=["checkers"])
    assert [i["store"] for i in result.items] == ["Checkers"]
    assert "another store" in caplog.text

    # Old data: a Pick n Pay item already linked to the Checkers "bread" search
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO items (store, sku, name, price) VALUES
                       ('Pick n Pay', 'old', 'PnP bread', 9.99) RETURNING id""")
        pnp_id = cur.fetchone()["id"]
        cur.execute("""INSERT INTO live_search_results (search_id, item_id, rank)
                       SELECT id, %s, 99 FROM live_searches WHERE query = 'bread'""", (pnp_id,))
    conn.commit()
    [cached] = live_search.search(conn, "bread", scrape=mixed, stores=["checkers"])
    assert cached.source == "cache"
    assert {i["store"] for i in cached.items} == {"Checkers"}
    assert cached.name == "Checkers"


def test_out_of_stock_items_come_last_with_no_price(conn):
    fake = FakeStore([{**_product("gone"), "price": 0, "in_stock": False},
                      _product("dear", 25.0), _product("cheap", 12.0)])
    [result] = live_search.search(conn, "beans", scrape=fake, stores=["checkers"])
    assert [i["name"] for i in result.items] == ["Bread dear", "Bread cheap", "Bread gone"]
    gone = result.items[-1]
    assert gone["price"] is None and gone["in_stock"] is False
    assert all(i["price"] is None or i["price"] > 0 for i in result.items)   # never R0


def test_no_active_stores(conn):
    assert live_search.search(conn, "bread", scrape=FakeStore([_product("a")]), stores=[]) == []
