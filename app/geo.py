"""
Distance and travel-cost helpers — shared by Member 5 (recommender) and
Member 6 (true cost).

Why this exists: "cheapest" is not the same as "cheapest for me". A R20
saving at a store 8 km away costs more in taxi fare than it saves, so both
the recommender and the true-cost calculator need the distance between the
student and the store, and a rough rand value for getting there.

Everything here is a pure function except fetch_user_location(), which takes
a cursor the caller already owns — so the maths can be unit-tested without a
database (see tests/test_geo.py).
"""

from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP
from math import asin, cos, radians, sin, sqrt
from typing import Optional, Tuple

# Mean Earth radius (km). Haversine on a sphere is accurate to well under a
# percent over city distances, which is far better than we need.
EARTH_RADIUS_KM = 6371.0088

# Minibus-taxi ballpark for Durban, in ZAR. These are deliberately editable
# constants rather than magic numbers buried in a formula — if the team gets
# better figures, change them here and every estimate follows.
DEFAULT_TRAVEL_RATE_PER_KM = Decimal("2.50")
DEFAULT_MINIMUM_FARE = Decimal("10.00")

# Phase 4 (Member 6): at or under this distance the student walks, so
# collection costs nothing to get there. Before this existed a store 400 m from
# campus was charged the R10 minimum taxi fare each way — R20 on top of an R18
# loaf — which made every walk-in store look dearer than it is and pushed the
# recommender towards stores students would never take a taxi to. 1.5 km is
# roughly a 20-minute walk; change it here and every estimate follows.
WALKING_DISTANCE_KM = 1.5

# Past this, a "nearby" store isn't really nearby any more. Used only when the
# student has not set preferences.max_distance_km.
DEFAULT_MAX_DISTANCE_KM = 15.0

Coordinate = Tuple[float, float]


def _as_float(value) -> Optional[float]:
    """Postgres NUMERIC comes back as Decimal; the trig needs floats."""
    if value is None:
        return None
    return float(value)


def _money(value: Decimal) -> Decimal:
    return Decimal(value).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def haversine_km(lat1, lon1, lat2, lon2) -> float:
    """
    Great-circle distance in kilometres between two lat/lng pairs.

    Accepts floats, Decimals or numeric strings, so it can be fed straight
    from a psycopg2 row.
    """
    lat1, lon1 = _as_float(lat1), _as_float(lon1)
    lat2, lon2 = _as_float(lat2), _as_float(lon2)
    if None in (lat1, lon1, lat2, lon2):
        raise ValueError("haversine_km needs four non-null coordinates")

    d_lat = radians(lat2 - lat1)
    d_lon = radians(lon2 - lon1)
    a = (
        sin(d_lat / 2) ** 2
        + cos(radians(lat1)) * cos(radians(lat2)) * sin(d_lon / 2) ** 2
    )
    return 2 * EARTH_RADIUS_KM * asin(sqrt(a))


def distance_between(
    origin: Optional[Coordinate], destination: Optional[Coordinate]
) -> Optional[float]:
    """
    None-safe wrapper around haversine_km.

    Returns None when either point is unknown — an online store has no
    coordinates, and a student who hasn't saved a location has no origin.
    Callers must treat None as "distance unknown", never as "zero km".
    """
    if not origin or not destination:
        return None
    if origin[0] is None or origin[1] is None:
        return None
    if destination[0] is None or destination[1] is None:
        return None
    return haversine_km(origin[0], origin[1], destination[0], destination[1])


def within_radius(distance_km: Optional[float], max_distance_km: Optional[float]) -> bool:
    """
    True when a store is close enough to count as reachable.

    Unknown distance passes: we'd rather show an online store than silently
    drop it because it has no coordinates.
    """
    if max_distance_km is None or distance_km is None:
        return True
    return distance_km <= max_distance_km


def proximity_score(
    distance_km: Optional[float], max_distance_km: Optional[float] = None
) -> float:
    """
    Distance as a 0–1 score for the recommender: 1.0 on your doorstep,
    falling linearly to 0.0 at the cutoff, 0.0 beyond it.

    Unknown distance scores 0.5 (neutral) so a missing coordinate neither
    rewards nor punishes a store.
    """
    if distance_km is None:
        return 0.5
    ceiling = max_distance_km if max_distance_km else DEFAULT_MAX_DISTANCE_KM
    if ceiling <= 0:
        return 0.0
    if distance_km <= 0:
        return 1.0
    if distance_km >= ceiling:
        return 0.0
    return round(1.0 - (distance_km / ceiling), 4)


def estimate_travel_cost(
    distance_km: Optional[float],
    rate_per_km: Optional[Decimal] = None,
    minimum_fare: Optional[Decimal] = None,
    return_trip: bool = True,
    walking_distance_km: Optional[float] = None,
) -> Decimal:
    """
    Rough rand cost of physically getting to a store and back.

    Deliberately conservative and clearly labelled as an estimate in the API
    response — it's a budgeting nudge ("this R20 saving costs R24 to fetch"),
    not a fare quote. Returns 0.00 when the distance is unknown, or when the
    store is within walking distance (WALKING_DISTANCE_KM).
    """
    if distance_km is None or distance_km <= 0:
        return Decimal("0.00")
    walk = WALKING_DISTANCE_KM if walking_distance_km is None else walking_distance_km
    if distance_km <= walk:
        return Decimal("0.00")

    rate = rate_per_km if rate_per_km is not None else DEFAULT_TRAVEL_RATE_PER_KM
    floor = minimum_fare if minimum_fare is not None else DEFAULT_MINIMUM_FARE

    legs = 2 if return_trip else 1
    one_way = max(_money(Decimal(str(distance_km)) * Decimal(rate)), Decimal(floor))
    return _money(one_way * legs)


def fetch_user_location(cur, user_id: int) -> Optional[Coordinate]:
    """
    The student's default saved location, or None if they haven't set one.

    Takes an open cursor so it joins whatever transaction the caller is
    already in, matching the style of the other routers.
    """
    cur.execute(
        """SELECT latitude, longitude
           FROM user_locations
           WHERE user_id = %s
           ORDER BY is_default DESC, id ASC
           LIMIT 1""",
        (user_id,),
    )
    row = cur.fetchone()
    if not row or row["latitude"] is None or row["longitude"] is None:
        return None
    return (float(row["latitude"]), float(row["longitude"]))
