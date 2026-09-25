"""
Phase 4, Member 5 — "tune recommendation scoring based on integration-test
results".

scripts/eval_recommender.py is the integration test: 208 searches over the
real catalogue (4 students x delivery/collection x 26 queries), every top pick
judged with the corrected true-cost model. These tests pin the tuned result so
it can't quietly regress, plus one test per individual change.

Measured against the Phase 3 code the same way:
    unfulfillable top picks   92 -> 0
    dearer-than-needed picks  77 (R1 704.78) -> 3 (R4.77)
    results over a ceiling   116 -> 0
    relevance hits          201 -> 208 of 208
"""

import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from app.query_parser import parse_query
from app.recommender import (
    DEFAULT_WEIGHTS, Candidate, UserContext, names_the_query, recommend,
    relevance_score, weights_for,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import eval_recommender as harness  # noqa: E402

D = Decimal
NOW = datetime(2026, 9, 23, 12, 0, tzinfo=timezone.utc)


def test_integration_metrics_after_tuning():
    from app.recommender import Candidate as C, UserContext as U, recommend as rec
    totals, regrets = harness.evaluate(rec, C, U, harness.phase4_pricer_factory())
    assert totals["searches"] == 208
    assert totals["relevance_hit"] == 208
    assert totals["unfulfillable"] == 0
    assert totals["over_ceiling"] == 0
    assert totals["affordability"] == 0
    # The residual regret is deliberate: Game (1.4 km, walkable) over Makro
    # (5 km, a taxi) to save R1.59 on earphones. That is the time-and-effort
    # nudge proximity keeps for collection. Anything more is a regression.
    assert totals["regret_count"] <= 3
    assert totals["regret_rands"] < D("5.00")


def test_weights_sum_to_one_in_every_mode():
    for mode in ("delivery", "collection", None):
        assert abs(sum(weights_for(mode).values()) - 1.0) < 1e-9
    assert weights_for("delivery")["proximity"] == 0.0
    assert weights_for("collection")["proximity"] == 0.04
    # Anything unrecognised gets the Phase 3 weights untouched.
    assert weights_for(None) == DEFAULT_WEIGHTS


def cand(offer_id, name, price, **kw):
    base = dict(offer_id=offer_id, product_id=offer_id, product_name=name,
                category="Groceries", is_essential=True, store_id=offer_id,
                store_name=f"Store {offer_id}", store_type="online",
                price=D(price), last_updated=NOW)
    base.update(kw)
    return Candidate(**base)


def test_sugar_is_sugar_not_sugar_beans():
    beans = cand(1, "Sugar Beans", "32.99")
    sugar = cand(2, "White Sugar", "59.99")
    parsed = parse_query("sugar")
    assert relevance_score(sugar, parsed) > relevance_score(beans, parsed)
    assert names_the_query(sugar, parsed) and not names_the_query(beans, parsed)
    results = recommend([beans, sugar], UserContext(remaining_amount=D("1000")), parsed, now=NOW)
    assert results[0].candidate.product_name == "White Sugar"


def test_form_words_do_not_hide_the_product():
    parsed = parse_query("soap")
    assert names_the_query(cand(1, "Sunlight Soap Bar", "13.99"), parsed)
    assert names_the_query(cand(2, "Toilet Paper 2-Ply", "70"), parse_query("toilet paper"))
    assert names_the_query(cand(3, "Frozen Chicken Portions", "89"), parse_query("chicken"))


def test_ceiling_is_enforced_on_true_cost():
    """'under R50' may not return a R56 true cost — Phase 3 did."""
    items = [cand(1, "Bread", "20.00", shipping_cost=D("35.00")),
             cand(2, "Bread", "45.00")]
    results = recommend(items, UserContext(remaining_amount=D("500")),
                        parse_query("bread under R50"), now=NOW)
    assert [r.candidate.offer_id for r in results] == [2]


def test_unfulfillable_offers_are_not_recommended():
    online = cand(1, "Pens", "10.00", shipping_cost=D("60.00"))
    walk_in = cand(2, "Pens", "40.00", store_type="physical")
    ctx = UserContext(remaining_amount=D("500"), fulfilment="collection")
    from app.true_cost import store_true_cost

    def pricer(c, _):
        return store_true_cost(c.to_offer(), fulfilment="collection")

    results = recommend([online, walk_in], ctx, parse_query("pens"), pricer=pricer, now=NOW)
    assert [r.candidate.offer_id for r in results] == [2]


def test_estimated_prices_are_not_fresh_and_say_so():
    estimate = cand(1, "Bread", "20.00", price_source="seed_estimate")
    confirmed = cand(2, "Bread", "20.00", price_source="live_api", price_verified_at=NOW)
    results = recommend([estimate, confirmed], UserContext(remaining_amount=D("500")),
                        parse_query("bread"), now=NOW)
    by_id = {r.candidate.offer_id: r for r in results}
    assert by_id[1].components["freshness"] == 0.0
    assert by_id[2].components["freshness"] == 1.0
    assert "estimated price" in by_id[1].explanation
    assert "estimated price" not in by_id[2].explanation
    assert results[0].candidate.offer_id == 2      # same price: the confirmed one wins
