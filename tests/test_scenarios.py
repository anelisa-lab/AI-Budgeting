"""
Recommendation output against sample budgets — Member 5, Phase 3.

The Phase 3 task is "test recommendation output against 3-4 sample
budgets/scenarios". The other test files use small invented candidates to pin
down one rule each; this one runs the whole pipeline — parse, filter, true
cost, budget fit, rank — over **Member 9's real catalogue** for four students
in genuinely different situations:

    1. Broke student, three days to payout       (R60 left, R20 a day)
    2. Payday, full allowance                    (R2 400 over 30 days)
    3. Survival mode                             (essentials only)
    4. Living off-campus                         (distance and travel cost)

Why the real catalogue and not fixtures: every bug this file was written
after came from real data, not from invented rows. Synthetic candidates all
had distinct names and tidy categories, so Phase 2's tests passed while the
live system ranked Baked Beans first for "maize meal" and returned nothing
at all for "kettle". The catalogue is read straight from
mintly-react/docs/seed/products.json — Member 9's source of truth — so these
tests break when the data changes, which is exactly what we want.

Still no database needed: products.json is a file, and the ranking logic is
pure. The store charges below mirror sql/seed_store_charges.sql.
"""

from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
import json

from app.budget_split import build_split
from app.geo import distance_between
from app.query_parser import parse_query
from app.recommender import Candidate, UserContext, recommend
from app.true_cost import ChargeRule, store_true_cost

D = Decimal
NOW = datetime(2026, 9, 23, 12, 0, tzinfo=timezone.utc)

# Where the student is standing. DUT's Steve Biko campus, Durban.
CAMPUS = (-29.8500, 31.0100)

SEED = Path(__file__).resolve().parents[1] / "mintly-react" / "docs" / "seed" / "products.json"

# Mirrors sql/seed_store_charges.sql, so true cost here matches true cost in a
# seeded database.
#
# Phase 4 (Member 6): the Phase 2 seed invented a R3.50 card surcharge, a R2
# bag levy and a 2.5% online handling fee. None of them had a source, and the
# surcharge alone added R3.50 to every in-store price on the Compare screen.
# The only store charge left is each store's own delivery fee and free-delivery
# threshold, taken from Member 9's store table (stores.csv).
STORES = {s["store_id"]: s for s in json.loads(SEED.read_text())["stores"]}


def charges_for(store_id):
    store = STORES.get(store_id, {})
    if not store.get("delivery_available"):
        return []
    free_over = store.get("free_delivery_over") or None
    return [
        ChargeRule(
            charge_type="delivery", label="Delivery", applies_to="delivery",
            amount=D(str(store["base_shipping_fee"])),
            free_over_amount=D(str(free_over)) if free_over else None,
        )
    ]


def load_catalogue():
    """Every in-stock listing in Member 9's dataset, as Candidates."""
    data = json.loads(SEED.read_text())
    stores = {s["store_id"]: s for s in data["stores"]}

    catalogue = []
    for index, row in enumerate(data["products"], start=1):
        if not row.get("in_stock"):
            continue
        store = stores.get(row["store_id"], {})
        online = bool(store.get("online_only"))
        catalogue.append(
            Candidate(
                offer_id=index,
                product_id=index,
                product_name=row["name"],
                brand=row.get("brand"),
                category=row.get("category"),
                subcategory=row.get("subcategory"),
                colour=row.get("colour") if row.get("colour") != "n/a" else None,
                size=row.get("size"),
                # Matches build_backend_seed.py's ESSENTIAL_CATEGORIES.
                is_essential=row.get("category") in {"Groceries", "Toiletries"},
                store_id=row["store_id"],
                store_name=row.get("store_name"),
                store_type="online" if online else "physical",
                store_latitude=None if online else row.get("store_lat"),
                store_longitude=None if online else row.get("store_lng"),
                price=D(str(row["price"])),
                shipping_cost=D(str(row.get("shipping_fee") or 0)),
                availability_status="available",
                rating=D(str(row["rating"])) if row.get("rating") is not None else None,
                rating_count=0,
                last_updated=NOW,
                delivery_available=bool(store.get("delivery_available")),
                collection_available=bool(store.get("collection_available")),
            )
        )
    return catalogue


CATALOGUE = load_catalogue()


def make_pricer(fulfilment="delivery"):
    def pricer(candidate, context):
        charges = charges_for(candidate.store_id)
        distance_km = None
        if candidate.store_type != "online":
            distance_km = distance_between(
                context.location, (candidate.store_latitude, candidate.store_longitude)
            )
        return store_true_cost(
            candidate.to_offer(), charges,
            fulfilment=fulfilment, distance_km=distance_km,
        )
    return pricer


def context_for(budget_row, as_of, **overrides):
    """Build a UserContext the way routers/recommendations.py does."""
    split = build_split(budget_row, as_of=as_of)
    base = dict(
        remaining_amount=budget_row["remaining_amount"],
        daily_limit=split.remaining_today,
        budget_mode=split.mode,
        location=CAMPUS,
        max_distance_km=15.0,
    )
    base.update(overrides)
    return UserContext(**base), split


def budget_row(remaining, end, start="2026-09-01", threshold=None):
    return {
        "id": 1,
        "currency": "ZAR",
        "remaining_amount": D(remaining),
        "cycle_start_date": date.fromisoformat(start),
        "cycle_end_date": date.fromisoformat(end),
        "survival_threshold": D(threshold) if threshold else None,
    }


def run(query, context, limit=5, fulfilment="delivery"):
    context.fulfilment = fulfilment
    return recommend(
        CATALOGUE, context, parse_query(query),
        pricer=make_pricer(fulfilment), limit=limit, now=NOW,
    )


# ---------------------------------------------------------------------------
# Sanity: the catalogue loaded and is the shape the recommender expects
# ---------------------------------------------------------------------------


def test_catalogue_loaded():
    assert len(CATALOGUE) > 100
    assert {c.category for c in CATALOGUE} == {
        "Groceries", "Toiletries", "Homeware", "Stationery", "Electronics"
    }
    # The two attributes the seed used to drop. Without them, two of the seven
    # scoring components are constant across every row.
    assert any(c.subcategory for c in CATALOGUE)
    assert any(c.rating for c in CATALOGUE)


def test_searches_return_the_thing_that_was_searched_for():
    """
    The regression that started Phase 3. Each of these ranked something
    unrelated first before the relevance component existed.
    """
    expected = {
        "maize meal": "Super Maize Meal",
        "rice": "Parboiled White Rice",
        "toothpaste": "Toothpaste",
        "sanitary pads": "Sanitary Pads",
        "kettle": "Kettle",
        "washing powder": "Auto Washing Powder",
        "shampoo": "Shampoo",
        "calculator": "Scientific Calculator",
    }
    ctx, _ = context_for(budget_row("2400.00", "2026-10-31"), date(2026, 9, 23))
    for query, product in expected.items():
        results = run(query, ctx, limit=1)
        assert results, f"{query!r} returned nothing"
        assert results[0].candidate.product_name == product, (
            f"{query!r} ranked {results[0].candidate.product_name!r} first"
        )


# ---------------------------------------------------------------------------
# Scenario 1 — broke student, three days to payout
# ---------------------------------------------------------------------------


def test_scenario_broke_student_three_days_to_payout():
    row = budget_row("60.00", "2026-09-25")
    ctx, split = context_for(row, date(2026, 9, 23))

    assert split.days_remaining == 3
    assert split.daily_limit == D("20.00")

    results = run("bread", ctx)
    assert results, "a student with R60 must still be shown bread"

    top = results[0]
    assert top.meets_budget is True
    assert top.true_cost <= D("60.00")

    # Anything over the remaining balance is kept but ranked last and flagged,
    # so the student sees it exists without being told to buy it.
    affordable = [r for r in results if r.meets_budget]
    unaffordable = [r for r in results if not r.meets_budget]
    if unaffordable:
        assert max(r.rank for r in affordable) < min(r.rank for r in unaffordable)

    # Every recommendation explains itself — non-negotiable for this app.
    assert all(r.explanation.strip() for r in results)


def test_scenario_broke_student_is_not_offered_electronics():
    """R60 left: a R250 power bank is not a recommendation, it's an insult."""
    row = budget_row("60.00", "2026-09-25")
    ctx, _ = context_for(row, date(2026, 9, 23))
    results = run("power bank", ctx, limit=5)
    assert all(not r.meets_budget for r in results)
    assert all("over your remaining budget" in r.explanation for r in results)


# ---------------------------------------------------------------------------
# Scenario 2 — payday, full allowance
# ---------------------------------------------------------------------------


def test_scenario_payday_ranks_on_true_cost_not_sticker_price():
    """
    The headline claim of the whole feature, checked against real prices:
    the winner must be the cheapest to actually pay for, not the cheapest
    on the shelf.
    """
    row = budget_row("2400.00", "2026-10-23")
    ctx, split = context_for(row, date(2026, 9, 23))
    assert split.daily_limit == D("77.41")      # 2400 / 31 days, rounded down

    results = run("maize meal", ctx, limit=10)
    assert len(results) > 1

    by_true_cost = sorted(results, key=lambda r: r.true_cost)
    assert results[0].true_cost == by_true_cost[0].true_cost

    # Somewhere in the real data, cheapest-on-the-shelf and cheapest-all-in
    # disagree — that difference is the reason this feature exists.
    cheapest_sticker = min(results, key=lambda r: r.candidate.price)
    cheapest_true = min(results, key=lambda r: r.true_cost)
    assert cheapest_true.true_cost <= cheapest_sticker.true_cost


def test_scenario_payday_true_cost_exceeds_sticker_where_fees_apply():
    row = budget_row("2400.00", "2026-10-23")
    ctx, _ = context_for(row, date(2026, 9, 23))
    results = run("rice", ctx, limit=20)

    with_fees = [r for r in results if r.breakdown.hidden_cost > 0]
    assert with_fees, "the seeded charges should add something to some offer"
    for item in with_fees:
        assert item.true_cost > item.candidate.price
        assert "delivery and fees" in item.explanation


# ---------------------------------------------------------------------------
# Scenario 3 — survival mode
# ---------------------------------------------------------------------------


def test_scenario_survival_mode_offers_only_essentials():
    row = budget_row("90.00", "2026-09-30", threshold="150.00")
    ctx, split = context_for(row, date(2026, 9, 23))

    assert split.mode == "survival"
    assert ctx.budget_mode == "survival"

    # A student in survival mode asking for a kettle gets nothing, because a
    # kettle is not food and they have R90 to last a week.
    assert run("kettle", ctx) == []

    # Food still comes through.
    food = run("bread", ctx)
    assert food
    assert all(r.candidate.is_essential for r in food)


# ---------------------------------------------------------------------------
# Scenario 4 — living off-campus, distance matters
# ---------------------------------------------------------------------------


def test_scenario_distance_changes_the_winner():
    """
    Same student, same budget, same query — only the location differs. The
    ranking must follow them.
    """
    row = budget_row("1200.00", "2026-10-15")

    on_campus, _ = context_for(row, date(2026, 9, 23), location=CAMPUS)
    # Pinetown, roughly 15 km west.
    off_campus, _ = context_for(
        row, date(2026, 9, 23), location=(-29.8200, 30.8700), max_distance_km=25.0
    )

    near = run("rice", on_campus, limit=5)
    far = run("rice", off_campus, limit=5)

    assert near and far
    # Distances are measured from wherever the student actually is.
    near_top = [r for r in near if r.distance_km is not None]
    far_top = [r for r in far if r.distance_km is not None]
    assert near_top and far_top
    assert near_top[0].distance_km != far_top[0].distance_km


def test_scenario_collection_adds_travel_and_drops_delivery():
    row = budget_row("1200.00", "2026-10-15")
    ctx, _ = context_for(row, date(2026, 9, 23))

    delivered = run("toothpaste", ctx, limit=5, fulfilment="delivery")
    collected = run("toothpaste", ctx, limit=5, fulfilment="collection")
    assert delivered and collected

    from app.geo import WALKING_DISTANCE_KM
    for item in collected:
        assert item.breakdown.shipping == D("0.00")
        # Phase 4: nothing that can't be collected is recommended for collection.
        assert item.candidate.store_type != "online"
        if item.distance_km and item.distance_km > WALKING_DISTANCE_KM:
            assert item.breakdown.travel_cost > 0
            # The explanation must name the taxi fare as a taxi fare, not
            # bundle it into "delivery and fees".
            assert "getting there and back" in item.explanation
        else:
            assert item.breakdown.travel_cost == D("0.00")

    # And nothing that doesn't deliver is recommended for delivery.
    assert all(i.candidate.delivery_available is not False for i in delivered)


def test_scenario_store_too_far_is_dropped():
    """A 2 km radius should cut the catalogue down, not return everything."""
    row = budget_row("1200.00", "2026-10-15")
    tight, _ = context_for(row, date(2026, 9, 23), max_distance_km=2.0)
    wide, _ = context_for(row, date(2026, 9, 23), max_distance_km=50.0)

    assert len(run("rice", tight, limit=50)) < len(run("rice", wide, limit=50))


# ---------------------------------------------------------------------------
# Cross-cutting behaviour on real data
# ---------------------------------------------------------------------------


def test_unmatched_word_falls_back_to_the_category():
    """
    The catalogue calls it an "A4 Feint & Margin Book"; students call it a
    notebook. An empty screen would be the wrong answer.
    """
    row = budget_row("1200.00", "2026-10-15")
    ctx, _ = context_for(row, date(2026, 9, 23))

    results = run("notebook", ctx, limit=3)
    assert results
    assert all(r.candidate.category == "Stationery" for r in results)
    assert all(r.matched_query is False for r in results)
    assert "closest match in Stationery" in results[0].explanation


def test_phone_does_not_match_earphones():
    """Word-boundary matching: 'phone' is not a match for 'Wired Earphones'."""
    row = budget_row("1200.00", "2026-10-15")
    ctx, _ = context_for(row, date(2026, 9, 23))
    names = {r.candidate.product_name for r in run("phone charger", ctx, limit=5)}
    assert "Wired Earphones" not in names


def test_nonsense_query_returns_nothing_rather_than_the_cheapest_thing():
    row = budget_row("1200.00", "2026-10-15")
    ctx, _ = context_for(row, date(2026, 9, 23))
    assert run("quantum flux capacitor", ctx) == []


def test_scores_stay_in_range_and_ranks_are_sequential():
    row = budget_row("1200.00", "2026-10-15")
    ctx, _ = context_for(row, date(2026, 9, 23))
    results = run("groceries", ctx, limit=10)
    assert results
    assert [r.rank for r in results] == list(range(1, len(results) + 1))
    assert all(0.0 <= r.score <= 1.0 for r in results)
    for item in results:
        breakdown = item.breakdown
        total = (breakdown.subtotal + breakdown.shipping
                 + breakdown.charges_total + breakdown.travel_cost)
        assert total == breakdown.true_cost
