"""
GET /search/stores/nearby (app/routers/search.py) — "stores near you" on the
Search screen.

Runs only when TEST_DATABASE_URL points at a throwaway Postgres database, the
same convention as tests/test_shopping_list.py: load sql/schema.sql (idempotent)
and call the route function directly, as the logged-in user, against that
database.
"""

import os
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.routers import search as search_router

DB_URL = os.getenv("TEST_DATABASE_URL")

# A fixed origin and two stores at known distances from it, computed with
# app.geo.haversine_km: ~1.4 km and ~25 km away.
ORIGIN = (-29.8547, 31.0084)
NEAR = (-29.8600, 31.0220)   # ~1.4 km
FAR = (-29.7000, 31.2000)    # ~25 km


@pytest.fixture
def db(monkeypatch):
    if not DB_URL:
        pytest.skip("set TEST_DATABASE_URL to run the nearby-stores route tests")
    import psycopg2
    import psycopg2.extras

    def connect():
        return psycopg2.connect(DB_URL, cursor_factory=psycopg2.extras.RealDictCursor)

    conn = connect()
    root = Path(__file__).parent.parent / "sql"
    with conn.cursor() as cur:
        cur.execute((root / "schema.sql").read_text())
        cur.execute("DELETE FROM stores WHERE name LIKE 'Nearby Test %'")
        cur.execute("DELETE FROM users WHERE email LIKE '%@nearby.test'")
        cur.execute("""INSERT INTO users (name, email, password_hash)
                       VALUES ('has location', 'located@nearby.test', 'x'),
                              ('no location', 'unlocated@nearby.test', 'x')
                       RETURNING id""")
        located_id, unlocated_id = [r["id"] for r in cur.fetchall()]
        cur.execute(
            """INSERT INTO user_locations (user_id, label, latitude, longitude, is_default)
               VALUES (%s, 'Home', %s, %s, TRUE)""",
            (located_id, ORIGIN[0], ORIGIN[1]),
        )
        cur.execute(
            """INSERT INTO stores (name, store_type, address, latitude, longitude,
                                    delivery_available, collection_available)
               VALUES
                 ('Nearby Test Close', 'physical', '1 Close St', %s, %s, TRUE, TRUE),
                 ('Nearby Test Far', 'physical', '2 Far Ave', %s, %s, TRUE, TRUE),
                 ('Nearby Test Online', 'online', NULL, NULL, NULL, TRUE, FALSE)
               RETURNING id, name""",
            (NEAR[0], NEAR[1], FAR[0], FAR[1]),
        )
        stores = {r["name"]: r["id"] for r in cur.fetchall()}
    conn.commit()
    monkeypatch.setattr(search_router, "get_connection", connect)
    yield {"conn": conn, "located": located_id, "unlocated": unlocated_id, "stores": stores}
    conn.close()


def _nearby(db, *, max_distance_km=None, limit=20):
    # stores_nearby's optional params default to FastAPI's Query(...) sentinel
    # objects, only resolved to real values when the request goes through
    # FastAPI's dependency injection — calling the function directly (as every
    # route test in this suite does) must pass real values explicitly, never
    # rely on the bare defaults.
    return search_router.stores_nearby(
        max_distance_km=max_distance_km, limit=limit, user_id=db["located"],
    )


def test_needs_a_saved_location(db):
    with pytest.raises(HTTPException) as err:
        search_router.stores_nearby(max_distance_km=None, limit=20, user_id=db["unlocated"])
    assert err.value.status_code == 400
    assert "location" in err.value.detail.lower()


def test_returns_only_the_near_store_within_default_radius(db):
    out = _nearby(db)
    assert [r.store_name for r in out.results] == ["Nearby Test Close"]
    assert out.count == 1
    assert out.origin.label == "Home"
    assert 1.0 < out.results[0].distance_km < 2.0


def test_max_distance_km_widens_the_search(db):
    out = _nearby(db, max_distance_km=50)
    names = {r.store_name for r in out.results}
    assert names == {"Nearby Test Close", "Nearby Test Far"}
    # nearest first
    assert out.results[0].store_name == "Nearby Test Close"


def test_online_only_and_uncoordinated_stores_are_never_nearby(db):
    out = _nearby(db, max_distance_km=500)
    assert "Nearby Test Online" not in {r.store_name for r in out.results}


def test_preferences_max_distance_km_is_used_when_no_param_is_given(db):
    with db["conn"].cursor() as cur:
        cur.execute(
            """INSERT INTO preferences (user_id, max_distance_km)
               VALUES (%s, 30) ON CONFLICT (user_id) DO UPDATE SET max_distance_km = 30""",
            (db["located"],),
        )
    db["conn"].commit()
    out = _nearby(db)
    assert {r.store_name for r in out.results} == {"Nearby Test Close", "Nearby Test Far"}
    assert out.max_distance_km == 30.0


def test_limit_caps_the_results(db):
    out = search_router.stores_nearby(user_id=db["located"], max_distance_km=50, limit=1)
    assert len(out.results) == 1
    assert out.results[0].store_name == "Nearby Test Close"
