"""Small, dependency-free geographic helpers used by recommendations."""

from decimal import Decimal, ROUND_HALF_UP
from math import asin, cos, radians, sin, sqrt
from typing import Optional, Tuple

Coordinate = Tuple[float, float]
EARTH_RADIUS_KM = 6371.0
DEFAULT_MAX_DISTANCE_KM = 25.0
DEFAULT_TRAVEL_RATE_PER_KM = Decimal("2.50")
DEFAULT_MINIMUM_FARE = Decimal("10.00")


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    lat_delta, lon_delta = radians(lat2 - lat1), radians(lon2 - lon1)
    a = sin(lat_delta / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(lon_delta / 2) ** 2
    return EARTH_RADIUS_KM * 2 * asin(sqrt(a))


def distance_between(origin: Optional[Coordinate], destination: Optional[Coordinate]) -> Optional[float]:
    if not origin or not destination or None in origin or None in destination:
        return None
    return haversine_km(*origin, *destination)


def within_radius(distance_km: Optional[float], max_distance_km: Optional[float]) -> bool:
    return max_distance_km is None or distance_km is None or distance_km <= max_distance_km


def proximity_score(distance_km: Optional[float], max_distance_km: Optional[float] = None) -> float:
    if distance_km is None:
        return 0.5
    ceiling = max_distance_km or DEFAULT_MAX_DISTANCE_KM
    return 0.0 if ceiling <= 0 or distance_km >= ceiling else round(max(0.0, 1 - distance_km / ceiling), 4)


def estimate_travel_cost(distance_km: Optional[float], rate_per_km: Optional[Decimal] = None,
                         minimum_fare: Optional[Decimal] = None, return_trip: bool = True) -> Decimal:
    if distance_km is None or distance_km <= 0:
        return Decimal("0.00")
    rate = rate_per_km or DEFAULT_TRAVEL_RATE_PER_KM
    minimum = minimum_fare or DEFAULT_MINIMUM_FARE
    one_way = max(Decimal(str(distance_km)) * rate, minimum)
    return (one_way * (2 if return_trip else 1)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def fetch_user_location(cur, user_id: int) -> Optional[Coordinate]:
    cur.execute(
        """SELECT latitude, longitude FROM user_locations
           WHERE user_id = %s ORDER BY is_default DESC, id ASC LIMIT 1""",
        (user_id,),
    )
    row = cur.fetchone()
    return (float(row["latitude"]), float(row["longitude"])) if row else None