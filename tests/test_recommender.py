"""
Recommender tests — Member 5.

Two halves:
  1. the component scores, one behaviour each
  2. four whole scenarios with real budgets, which is the Phase 3 task
     "test recommendation output against 3-4 sample budgets/scenarios"

No database: recommend() takes plain Candidate objects.
"""

from datetime import datetime, timedelta, timezone
from decimal import Decimal

from app.query_parser import parse_query
from app.recommender import (
    Candidate,
    UserContext,
    budget_fit_score,
    freshness_score,
    preference_match_score,
    price_value_score,
    rating_score,
    recommend,
)
from app.true_cost import ChargeRule, store_true_cost

D = Decimal
NOW = datetime(2026, 9, 22, 12, 0, tzinfo=timezone.utc)


def candidate(
    offer_id,
    price,
    *,
    shipping="0.00",
    name="Item",
    category="groceries",
    subcategory=None,
    colour=None,
    size=None,
    essential=True,
    store="Test Store",
    store_type="online",
    lat=None,
    lng=None,
    rating=None,
    rating_count=0,
    availability="available",
):
    return Candidate(
        offer_id=offer_id,
        product_id=offer_id,
        product_name=name,
        category=category,
        subcategory=subcategory,
        colour=colour,
        size=size,
        is_essential=essential,
        store_id=offer_id,
        store_name=store,
        store_type=store_type,
        store_latitude=lat,
        store_longitude=lng,
        price=D(price),
        shipping_cost=D(shipping),
        availability_status=availability,
        rating=D(rating) if rating else None,
        rating_count=rating_count,
        last_updated=NOW,
    )


# ---------------------------------------------------------------------------
# Component scores
# ---------------------------------------------------------------------------


def test_budget_fit_rewards_fitting_todays_allowance():
    assert budget_fit_score(D("50.00"), D("1000.00"), D("77.00")) == 1.0


def test_budget_fit_scores_lower_as_it_eats_the_balance():
    small = budget_fit_score(D("100.00"), D("1000.00"), D("20.00"))
    large = budget_fit_score(D("900.00"), D("1000.00"), D("20.00"))
    assert small > large > 0


def test_budget_fit_is_zero_when_unaffordable():
    assert budget_fit_score(D("1200.00"), D("1000.00"), D("50.00")) == 0.0
    assert budget_fit_score(D("10.00"), D("0.00")) == 0.0


def test_budget_fit_is_neutral_with_no_budget():
    assert budget_fit_score(D("500.00"), None) == 0.5


def test_price_value_is_relative_to_the_candidate_set():
    assert price_value_score(D("100"), D("100"), D("200")) == 1.0
    assert price_value_score(D("200"), D("100"), D("200")) == 0.0
    assert price_value_score(D("150"), D("100"), D("200")) == 0.5


def test_price_value_when_everything_costs_the_same():
    assert price_value_score(D("100"), D("100"), D("100")) == 1.0


def test_preference_match_is_neutral_when_nothing_was_expressed():
    score, reasons = preference_match_score(candidate(1, "50"), UserContext())
    assert score == 0.5
    assert reasons == []


def test_preference_match_counts_only_applicable_signals():
    context = UserContext(preferred_stores=["Shoprite"], preferred_categories=["groceries"])
    hit, reasons = preference_match_score(
        candidate(1, "50", store="Shoprite", category="groceries"), context
    )
    miss, miss_reasons = preference_match_score(
        candidate(2, "50", store="Woolworths", category="clothing"), context
    )
    assert hit == 1.0
    assert "Shoprite" in reasons[0] and "groceries" in reasons[0]
    assert miss == 0.0 and miss_reasons == []


def test_partial_preference_match_scores_between():
    context = UserContext(preferred_stores=["Shoprite"], preferred_categories=["groceries"])
    score, _ = preference_match_score(
        candidate(1, "50", store="Shoprite", category="clothing"), context
    )
    assert score == 0.5


def test_rating_score_discounts_thin_review_counts():
    well_reviewed = rating_score(D("5.0"), rating_count=40)
    barely_reviewed = rating_score(D("5.0"), rating_count=1)
    assert well_reviewed == 1.0
    assert 0.5 < barely_reviewed < well_reviewed
    assert rating_score(None) == 0.5


def test_freshness_decays_over_a_month():
    assert freshness_score(NOW, NOW) == 1.0
    assert freshness_score(NOW - timedelta(days=15), NOW) == 0.5
    assert freshness_score(NOW - timedelta(days=60), NOW) == 0.0
    assert freshness_score(None) == 0.3


# ---------------------------------------------------------------------------
# Scenario 1 — the feature's whole reason for existing
# ---------------------------------------------------------------------------


def test_scenario_true_cost_beats_sticker_price():
    """
    R199 + R60 courier + 2.5% handling (R4.98) = R263.98.
    R240 delivered free = R240.
    The cheaper-looking one must lose.
    """
    charges = {
        1: [ChargeRule(charge_type="service", label="Handling", calculation="percentage",
                       percentage=D("2.5"), applies_to="both")],
        2: [],
    }

    def pricer(cand, ctx):
        return store_true_cost(cand.to_offer(), charges[cand.offer_id])

    results = recommend(
        [candidate(1, "199.00", shipping="60.00"), candidate(2, "240.00")],
        UserContext(remaining_amount=D("1000.00"), daily_limit=D("300.00")),
        pricer=pricer,
        now=NOW,
    )

    assert results[0].candidate.offer_id == 2
    assert results[0].true_cost == D("240.00")
    assert results[1].true_cost == D("263.98")
    assert results[1].candidate.price < results[0].candidate.price   # cheaper shelf price
    assert "R64.98 of that is delivery and fees" in results[1].explanation


# ---------------------------------------------------------------------------
# Scenario 2 — student with R80 left and 4 days to payout
# ---------------------------------------------------------------------------


def test_scenario_broke_student_gets_what_they_can_actually_buy():
    context = UserContext(
        remaining_amount=D("80.00"),
        daily_limit=D("20.00"),          # what's left today
    )
    results = recommend(
        [
            candidate(1, "18.00", name="Bread and milk"),
            candidate(2, "75.00", name="Bulk maize meal"),
            candidate(3, "450.00", name="Sneakers", essential=False),
        ],
        context,
        now=NOW,
    )

    assert results[0].candidate.offer_id == 1          # fits today
    assert results[0].meets_budget is True
    assert "fits today's R20.00 allowance" in results[0].explanation

    unaffordable = [r for r in results if not r.meets_budget]
    assert [r.candidate.offer_id for r in unaffordable] == [3]
    assert unaffordable[0].rank == len(results)        # always ranked last
    assert "R370.00 over your remaining budget" in unaffordable[0].explanation


def test_scenario_unaffordable_can_be_hidden_entirely():
    results = recommend(
        [candidate(1, "18.00"), candidate(3, "450.00", essential=False)],
        UserContext(remaining_amount=D("80.00"), daily_limit=D("20.00")),
        include_unaffordable=False,
        now=NOW,
    )
    assert [r.candidate.offer_id for r in results] == [1]


# ---------------------------------------------------------------------------
# Scenario 3 — survival mode
# ---------------------------------------------------------------------------


def test_scenario_survival_mode_hides_non_essentials():
    context = UserContext(
        remaining_amount=D("60.00"), daily_limit=D("15.00"), budget_mode="survival"
    )
    results = recommend(
        [
            candidate(1, "12.00", name="Bread", essential=True),
            candidate(2, "40.00", name="Earphones", essential=False),
        ],
        context,
        now=NOW,
    )
    assert [r.candidate.offer_id for r in results] == [1]


# ---------------------------------------------------------------------------
# Scenario 4 — location and distance
# ---------------------------------------------------------------------------


def test_scenario_nearby_store_beats_one_across_town():
    """Both R100 in the shop; the one you can walk to wins."""
    context = UserContext(
        remaining_amount=D("1000.00"),
        daily_limit=D("200.00"),
        location=(-29.8587, 31.0218),        # Durban city centre
        max_distance_km=20.0,
    )
    results = recommend(
        [
            candidate(1, "100.00", store="Far Store", store_type="physical",
                      lat=-29.9500, lng=30.9200),
            candidate(2, "100.00", store="Corner Shop", store_type="physical",
                      lat=-29.8600, lng=31.0230),
        ],
        context,
        now=NOW,
    )
    assert results[0].candidate.offer_id == 2
    assert results[0].distance_km < 1
    assert results[0].components["proximity"] > results[1].components["proximity"]


def test_stores_beyond_the_distance_limit_are_dropped():
    context = UserContext(
        remaining_amount=D("1000.00"),
        location=(-29.8587, 31.0218),
        max_distance_km=2.0,
    )
    results = recommend(
        [
            candidate(1, "100.00", store_type="physical", lat=-30.5000, lng=31.5000),
            candidate(2, "100.00", store_type="physical", lat=-29.8600, lng=31.0230),
        ],
        context,
        now=NOW,
    )
    assert [r.candidate.offer_id for r in results] == [2]


def test_online_stores_survive_a_distance_limit():
    """An online store has no coordinates — that must not exclude it."""
    context = UserContext(remaining_amount=D("1000.00"), max_distance_km=1.0)
    results = recommend([candidate(1, "100.00", store_type="online")], context, now=NOW)
    assert len(results) == 1
    assert "delivered, no travel" in results[0].explanation


# ---------------------------------------------------------------------------
# Filters and plumbing
# ---------------------------------------------------------------------------


def test_out_of_stock_offers_are_dropped():
    results = recommend(
        [candidate(1, "50.00", availability="out_of_stock"), candidate(2, "60.00")],
        UserContext(remaining_amount=D("500.00")),
        now=NOW,
    )
    assert [r.candidate.offer_id for r in results] == [2]


def test_explicit_query_attributes_are_requirements_not_preferences():
    """A student who asked for black must not be shown blue, however cheap."""
    parsed = parse_query("black hoodie")
    results = recommend(
        [
            candidate(1, "50.00", category="clothing", colour="blue", essential=False),
            candidate(2, "300.00", category="clothing", colour="black", essential=False),
        ],
        UserContext(remaining_amount=D("1000.00")),
        parsed,
        now=NOW,
    )
    assert [r.candidate.offer_id for r in results] == [2]


def test_wrong_category_is_filtered_out():
    parsed = parse_query("calculator")
    results = recommend(
        [
            candidate(1, "20.00", category="groceries", name="Bread"),
            candidate(2, "249.00", category="stationery", name="Casio FX-82"),
        ],
        UserContext(remaining_amount=D("1000.00")),
        parsed,
        now=NOW,
    )
    assert [r.candidate.offer_id for r in results] == [2]


def test_missing_attribute_is_a_mismatch_not_a_free_pass():
    """Matches the SQL: `p.colour ILIKE 'black'` drops rows with a NULL colour."""
    results = recommend(
        [candidate(1, "50.00", category="clothing", colour=None, essential=False)],
        UserContext(remaining_amount=D("1000.00")),
        parse_query("black hoodie"),
        now=NOW,
    )
    assert results == []


def test_subcategory_gaps_do_not_filter_rows_out():
    """Seed data has NULL subcategories; the SQL lets them through, so must we."""
    parsed = parse_query("sanitary pads")
    assert parsed.subcategory == "sanitary"
    results = recommend(
        [candidate(1, "35.00", category="toiletries", subcategory=None)],
        UserContext(remaining_amount=D("1000.00")),
        parsed,
        now=NOW,
    )
    assert len(results) == 1


def test_query_matches_raise_preference_scores():
    parsed = parse_query("black hoodie")
    context = UserContext(remaining_amount=D("1000.00"), daily_limit=D("500.00"))
    results = recommend(
        [
            candidate(1, "300.00", category="clothing", subcategory="outerwear", colour="blue"),
            candidate(2, "300.00", category="clothing", subcategory="outerwear", colour="black"),
        ],
        context,
        parsed,
        now=NOW,
    )
    assert results[0].candidate.offer_id == 2
    assert results[0].meets_preferences is True


def test_ranks_are_sequential_and_capped_by_limit():
    candidates = [candidate(i, f"{i * 10}.00") for i in range(1, 11)]
    results = recommend(
        candidates, UserContext(remaining_amount=D("1000.00")), limit=3, now=NOW
    )
    assert [r.rank for r in results] == [1, 2, 3]


def test_no_candidates_returns_nothing_rather_than_failing():
    assert recommend([], UserContext(remaining_amount=D("100.00")), now=NOW) == []


def test_every_result_carries_an_explanation():
    results = recommend(
        [candidate(1, "50.00"), candidate(2, "80.00")],
        UserContext(remaining_amount=D("500.00"), daily_limit=D("100.00")),
        now=NOW,
    )
    assert all(r.explanation.strip() for r in results)
    assert all(0.0 <= r.score <= 1.0 for r in results)
