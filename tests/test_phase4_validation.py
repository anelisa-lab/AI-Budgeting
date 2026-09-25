"""
Phase 4, Member 6 — "validate true-cost & Daily Budget Split numbers across
test scenarios".

The Phase 2/3 tests pin one rule each with one hand-picked example. This file
checks the invariants that must hold for EVERY input, over a grid:

  true cost        every real catalogue offer x delivery/collection x
                   quantity 1/2/5 x walkable/taxi/unknown distance
                   (283 x 2 x 3 x 3 = 5 094 breakdowns)
  budget split     7 balances x 7 cycle lengths x 4 spend patterns x
                   with/without a survival threshold (392 splits),
                   plus payout day and a lapsed cycle

What this found (fixed in this phase, each with its own test elsewhere):
  * collecting from an online-only store was priced with no delivery and no
    travel, so it won every collection comparison     -> true_cost rule 7
  * a store that doesn't deliver was priced as FREE delivery
                                                      -> true_cost rule 7
  * a store 400 m away was charged R20 taxi fare      -> geo.WALKING_DISTANCE_KM
  * three store fees in the demo seed had no source   -> seed_store_charges.sql
The Daily Budget Split held every invariant below; nothing in it changed.
"""

import json
from datetime import date, timedelta
from decimal import Decimal
from itertools import product
from pathlib import Path

from app.budget_split import build_split, check_affordability, days_remaining
from app.geo import WALKING_DISTANCE_KM
from app.true_cost import ChargeRule, Offer, store_true_cost

D = Decimal
CENT = D("0.01")
SEED = Path(__file__).resolve().parents[1] / "mintly-react" / "docs" / "seed" / "products.json"
DATA = json.loads(SEED.read_text())
STORES = {s["store_id"]: s for s in DATA["stores"]}


def delivery_rules(store):
    if not store["delivery_available"]:
        return []
    free = store.get("free_delivery_over") or None
    return [ChargeRule(charge_type="delivery", label="Delivery", applies_to="delivery",
                       amount=D(str(store["base_shipping_fee"])),
                       free_over_amount=D(str(free)) if free else None)]


def offers():
    for i, row in enumerate(DATA["products"], start=1):
        store = STORES[row["store_id"]]
        yield store, Offer(
            offer_id=i, price=D(str(row["price"])), shipping_cost=D(str(row["shipping_fee"])),
            store_name=store["store_name"],
            store_type="online" if store["online_only"] else "physical",
            delivery_available=store["delivery_available"],
            collection_available=store["collection_available"],
        )


# ---------------------------------------------------------------------------
# True cost
# ---------------------------------------------------------------------------


def test_true_cost_invariants_over_the_whole_catalogue():
    checked = 0
    for (store, offer), fulfilment, qty, distance in product(
        list(offers()), ("delivery", "collection"), (1, 2, 5), (0.6, 5.0, None)
    ):
        dist = None if offer.store_type == "online" else distance
        b = store_true_cost(offer, delivery_rules(store), quantity=qty,
                            fulfilment=fulfilment, distance_km=dist)
        checked += 1
        where = f"{store['store_name']} {fulfilment} x{qty} @ {dist}"

        # The breakdown adds up, to the cent, always.
        assert b.subtotal + b.shipping + b.charges_total + b.travel_cost == b.true_cost, where
        assert b.subtotal == (offer.price * qty).quantize(CENT), where
        assert b.true_cost >= b.subtotal, where
        assert b.hidden_cost == b.true_cost - b.subtotal, where
        assert all(v >= 0 for v in (b.shipping, b.charges_total, b.travel_cost)), where

        # Priced the way the store can actually serve the student.
        can = offer.can_collect if fulfilment == "collection" else offer.can_deliver
        assert b.fulfilment_available == can, where
        if b.fulfilment == "collection":
            assert b.shipping == 0, where
        else:
            assert b.travel_cost == 0, where
            # Shipping is per order: quantity never multiplies it.
            assert b.shipping == offer.shipping_cost, where

        # Walkable is free; a taxi is at least the minimum fare both ways.
        if b.fulfilment == "collection" and dist is not None:
            if dist <= WALKING_DISTANCE_KM:
                assert b.travel_cost == 0, where
            else:
                assert b.travel_cost >= D("20.00"), where

        # Delivery is never charged twice.
        delivery_lines = [c for c in b.charges if c.charge_type == "delivery" and not c.waived]
        if b.shipping > 0:
            assert not delivery_lines, where
    assert checked == 283 * 2 * 3 * 3   # 257 + 26 Maintenance listings (Phase 5)


def test_free_delivery_threshold_is_tested_against_the_order_not_the_item():
    """R200 x 3 = R600 clears a R450 threshold even though one unit doesn't."""
    rule = ChargeRule(charge_type="delivery", label="Delivery", amount=D("50.00"),
                      applies_to="delivery", free_over_amount=D("450.00"))
    one = store_true_cost(Offer(offer_id=1, price=D("200.00")), [rule], quantity=1)
    three = store_true_cost(Offer(offer_id=1, price=D("200.00")), [rule], quantity=3)
    assert one.charges_total == D("50.00")
    assert three.charges_total == D("0.00")
    assert three.charges[0].waived


def test_percentage_charges_stay_inside_their_clamp():
    rule = ChargeRule(charge_type="service", label="Fee", calculation="percentage",
                      percentage=D("2.50"), applies_to="both",
                      min_charge=D("5.00"), max_charge=D("45.00"))
    for price in ("1.00", "100.00", "199.99", "200.00", "1799.99", "5000.00"):
        b = store_true_cost(Offer(offer_id=1, price=D(price)), [rule])
        assert D("5.00") <= b.charges_total <= D("45.00"), price


# ---------------------------------------------------------------------------
# Daily Budget Split
# ---------------------------------------------------------------------------

TODAY = date(2026, 9, 24)
BALANCES = ("0.00", "0.01", "1.00", "59.99", "60.00", "1234.56", "2400.00")
CYCLE_DAYS = (1, 2, 3, 7, 14, 30, 31)


def budget(remaining, days, threshold=None):
    return {"id": 1, "currency": "ZAR", "remaining_amount": D(remaining),
            "cycle_start_date": TODAY - timedelta(days=5),
            "cycle_end_date": TODAY + timedelta(days=days - 1),
            "survival_threshold": D(threshold) if threshold else None}


def spend_patterns(remaining):
    r = D(remaining)
    return {
        "nothing": {},
        "a little today": {TODAY: min(r, D("5.00"))} if r > 0 else {},
        "a lot today": {TODAY: D("150.00")},
        "yesterday": {TODAY - timedelta(days=1): D("40.00")},
    }


def test_split_invariants_over_the_grid():
    checked = 0
    for remaining, days, threshold in product(BALANCES, CYCLE_DAYS, (None, "100.00")):
        for label, spent in spend_patterns(remaining).items():
            s = build_split(budget(remaining, days, threshold), as_of=TODAY, spent_by_date=spent)
            checked += 1
            where = f"R{remaining} over {days}d, {label}, threshold {threshold}"
            spent_today = spent.get(TODAY, D("0"))

            assert s.days_remaining == days, where
            assert s.daily_limit >= 0 and s.remaining_today >= 0, where
            assert s.remaining_today <= s.daily_limit, where

            # Today's allowance comes from the start-of-day balance, rounded
            # DOWN, so it never promises more than exists.
            start = s.remaining_amount + spent_today if s.remaining_amount > 0 else D("0")
            assert s.daily_limit * days <= start, where
            assert start - s.daily_limit * days < days * CENT, where

            # Today plus every later day never over-allocates the balance.
            if s.tomorrow_limit is not None:
                allocated = s.remaining_today + s.tomorrow_limit * (days - 1)
                assert allocated <= s.remaining_amount, where
                # ...and what rounding leaves over is less than a cent a day.
                leftover = s.remaining_amount - allocated
                assert D("0") <= leftover < (days - 1) * CENT, where
            else:
                assert days == 1, where

            # Overspending today zeroes today and says so.
            if spent_today > s.daily_limit and s.remaining_amount > 0 and s.mode != "survival":
                assert s.remaining_today == 0, where
                assert "over today's" in s.message, where

            # Survival mode is exactly "at or below the threshold".
            expected = "survival" if threshold and s.remaining_amount <= D(threshold) else "normal"
            assert s.mode == expected, where

            # The schedule starts today and never outruns the cycle.
            assert s.days[0].is_today and s.days[0].limit_date == TODAY, where
            assert len(s.days) == min(days, 14), where
            assert all(d.planned_limit >= 0 and d.remaining_limit >= 0 for d in s.days), where

            # No message ever shows a negative amount.
            assert "R-" not in s.message, where
    assert checked == len(BALANCES) * len(CYCLE_DAYS) * 2 * 4


def test_affordability_agrees_with_the_split():
    for remaining, days in product(BALANCES, CYCLE_DAYS):
        s = build_split(budget(remaining, days), as_of=TODAY)
        for amount in ("0.00", "0.01", str(s.remaining_today), "20.00", "77.41",
                       str(s.remaining_amount), "5000.00"):
            v = check_affordability(s, amount)
            a = D(amount)
            assert v.affordable_today == (a <= s.remaining_today)
            assert v.affordable_this_cycle == (a <= s.remaining_amount)
            if s.daily_limit > 0:
                assert v.days_of_budget == (a / s.daily_limit).quantize(D("0.1"), rounding="ROUND_HALF_UP")
            else:
                assert v.days_of_budget is None
            assert "R-" not in v.message


def test_payout_day_and_lapsed_cycle():
    payout_day = build_split(budget("45.50", 1), as_of=TODAY)
    assert payout_day.days_remaining == 1
    assert payout_day.daily_limit == D("45.50")          # the whole balance, today
    assert payout_day.tomorrow_limit is None

    lapsed = build_split(budget("45.50", 1), as_of=TODAY + timedelta(days=3))
    assert lapsed.days_remaining == 1
    assert lapsed.daily_limit == D("45.50")
    assert "payout date has passed" in lapsed.message
    assert days_remaining(TODAY, TODAY - timedelta(days=10)) == 1


def test_readme_demo_figures():
    """The numbers the CRUD demo script tells the markers to expect."""
    # R1 650, 10% aside -> R1 485 spendable over a 30-day cycle.
    s = build_split(budget("1485.00", 30), as_of=TODAY)
    assert s.daily_limit == D("49.50")
    assert s.tomorrow_limit == D("49.50")
    after = build_split(budget("1399.50", 30), as_of=TODAY, spent_by_date={TODAY: D("85.50")})
    assert after.daily_limit == D("49.50")            # fixed at the start of the day
    assert after.remaining_today == D("0.00")          # R85.50 is over today's R49.50
    assert after.tomorrow_limit == D("48.25")          # R1 399.50 / 29, rounded down
