"""Distance and travel-cost tests — shared helpers used by Members 5 and 6."""

from decimal import Decimal

import pytest

from app.geo import (
    distance_between,
    estimate_travel_cost,
    haversine_km,
    proximity_score,
    within_radius,
)

D = Decimal

DURBAN_CBD = (-29.8587, 31.0218)
UMHLANGA = (-29.7266, 31.0840)          # roughly 15 km north
DUT_STEVE_BIKO = (-29.8500, 31.0100)


def test_same_point_is_zero_km():
    assert haversine_km(*DURBAN_CBD, *DURBAN_CBD) == pytest.approx(0.0, abs=1e-9)


def test_known_distance_is_about_right():
    km = haversine_km(*DURBAN_CBD, *UMHLANGA)
    assert 14 < km < 17


def test_accepts_decimals_straight_from_postgres():
    km = haversine_km(D("-29.8587"), D("31.0218"), D("-29.7266"), D("31.0840"))
    assert 14 < km < 17


def test_distance_between_is_none_safe():
    assert distance_between(None, DURBAN_CBD) is None
    assert distance_between(DURBAN_CBD, None) is None
    assert distance_between(DURBAN_CBD, (None, None)) is None
    assert distance_between(DURBAN_CBD, DUT_STEVE_BIKO) is not None


def test_unknown_distance_passes_the_radius_check():
    """An online store with no coordinates must not be filtered out."""
    assert within_radius(None, 5.0) is True
    assert within_radius(3.0, None) is True
    assert within_radius(3.0, 5.0) is True
    assert within_radius(9.0, 5.0) is False


def test_proximity_score_falls_off_with_distance():
    assert proximity_score(0, 10) == 1.0
    assert proximity_score(5, 10) == 0.5
    assert proximity_score(10, 10) == 0.0
    assert proximity_score(99, 10) == 0.0


def test_proximity_score_is_neutral_when_distance_is_unknown():
    assert proximity_score(None) == 0.5


def test_travel_cost_is_a_return_trip():
    # 6 km x R2.50 = R15 each way
    assert estimate_travel_cost(6.0) == D("30.00")


def test_travel_cost_respects_the_minimum_fare():
    # 2 km is past walking distance: 2 x R2.50 = R5, raised to the R10
    # minimum, both ways.
    assert estimate_travel_cost(2.0) == D("20.00")


def test_walking_distance_costs_nothing():
    """
    Phase 4 (Member 6). This test used to assert that a store 400 m away cost
    R20 in taxi fare. That was the rule working as written and the number
    being wrong: nobody takes a taxi 400 m, and the R20 was bigger than the
    bread it was added to.
    """
    assert estimate_travel_cost(0.4) == D("0.00")
    assert estimate_travel_cost(1.5) == D("0.00")      # the boundary walks
    assert estimate_travel_cost(1.51) == D("20.00")    # just past it rides


def test_walking_distance_can_be_overridden():
    assert estimate_travel_cost(0.4, walking_distance_km=0) == D("20.00")


def test_travel_cost_is_zero_without_a_distance():
    assert estimate_travel_cost(None) == D("0.00")
    assert estimate_travel_cost(0) == D("0.00")


def test_travel_rate_can_be_overridden():
    assert estimate_travel_cost(10.0, rate_per_km=D("1.00")) == D("20.00")
