"""
Recommender integration evaluation — Member 5, Phase 4.

    python3 scripts/eval_recommender.py            # tuned weights (what ships)
    python3 scripts/eval_recommender.py --legacy   # Phase 3 weights, for comparison

Phase 4's task is "tune recommendation scoring based on integration-test
results". This is the integration test the tuning was based on. It runs the
whole pipeline — parse, filter, true cost, budget fit, rank — over Member 9's
real catalogue for 4 students x 2 ways of getting the item x 26 searches, and
scores every top pick against what a careful student would have chosen.

Every pick is judged with the CORRECTED true-cost model (app/true_cost.py as
of Phase 4), so a recommender can't look good by being scored with the same
mistakes it made.

Metrics (lower is better except relevance):

    relevance_hit     top pick is the product that was asked for
    unfulfillable     top pick can't be had the way the student asked
                      (collect from an online-only store; delivery from a
                      store that doesn't deliver)
    regret_count      top pick is a dearer offer of the same product than one
                      the student could have had instead
    regret_rands      total rands those picks cost the students
    over_ceiling      results above a price the student stated ("under R40")
    affordability     an unaffordable result ranked above an affordable one
                      of the same relevance tier

Results measured on 24 Sep 2026 (see docs/PHASE4_M5_M6_REPORT.md):

                              Phase 3 code   Phase 4
    relevance hit               201/208      208/208
    unfulfillable top pick           92            0
    dearer-than-needed pick          77            3
      ...costing students     R1 704.78        R4.77
    results over ceiling            116            0

No database needed.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.budget_split import build_split  # noqa: E402
from app.geo import distance_between, within_radius  # noqa: E402
from app.query_parser import parse_query  # noqa: E402
from app.true_cost import ChargeRule, Offer, store_true_cost  # noqa: E402

D = Decimal
NOW = datetime(2026, 9, 23, 12, 0, tzinfo=timezone.utc)
TODAY = date(2026, 9, 23)
CAMPUS = (-29.8500, 31.0100)
SEED = ROOT / "mintly-react" / "docs" / "seed" / "products.json"
DATA = json.loads(SEED.read_text())
STORES = {s["store_id"]: s for s in DATA["stores"]}

# query -> acceptable product names. A set where more than one product is a
# fair answer ("soap": either soap).
QUERIES = {
    "bread": {"White Bread", "Brown Bread"},
    "brown bread": {"Brown Bread"},
    "milk": {"Full Cream Milk"},
    "maize meal": {"Super Maize Meal"},
    "rice": {"Parboiled White Rice"},
    "sugar": {"White Sugar"},
    "beans": {"Sugar Beans", "Baked Beans"},
    "soap": {"Sunlight Soap Bar", "Antibacterial Soap"},
    "toothpaste": {"Toothpaste"},
    "eggs": {"Large Eggs"},
    "chicken": {"Frozen Chicken Portions"},
    "noodles": {"2-Minute Noodles"},
    "oil": {"Sunflower Oil"},
    "toilet paper": {"Toilet Paper 2-Ply"},
    "washing powder": {"Auto Washing Powder"},
    "sanitary pads": {"Sanitary Pads"},
    "peanut butter": {"Peanut Butter"},
    "pens": {"Ballpoint Pens"},
    "calculator": {"Scientific Calculator"},
    "kettle": {"Kettle"},
    "earphones": {"Wired Earphones"},
    "towel": {"Bath Towel"},
    "flash drive": {"USB Flash Drive"},
    "bread under R25": {"White Bread", "Brown Bread"},
    "milk under R40": {"Full Cream Milk"},
    "rice under R50": {"Parboiled White Rice"},
}

SCENARIOS = {
    "broke (R60, 3 days)": dict(remaining="60.00", end="2026-09-25"),
    "payday (R2400, 31 days)": dict(remaining="2400.00", end="2026-10-23"),
    "survival (R90, threshold R150)": dict(remaining="90.00", end="2026-09-30", threshold="150.00"),
    "mid-month (R1200)": dict(remaining="1200.00", end="2026-10-15"),
}


def delivery_rules(store_id):
    store = STORES.get(store_id, {})
    if not store.get("delivery_available"):
        return []
    free_over = store.get("free_delivery_over") or None
    return [ChargeRule(charge_type="delivery", label="Delivery", applies_to="delivery",
                       amount=D(str(store["base_shipping_fee"])),
                       free_over_amount=D(str(free_over)) if free_over else None)]


def corrected_cost(row, fulfilment):
    """The Phase 4 true cost of one catalogue row — the yardstick."""
    store = STORES[row["store_id"]]
    online = bool(store["online_only"])
    offer = Offer(
        offer_id=0, price=D(str(row["price"])), shipping_cost=D(str(row["shipping_fee"])),
        store_name=store["store_name"], store_type="online" if online else "physical",
        delivery_available=bool(store["delivery_available"]),
        collection_available=bool(store["collection_available"]),
    )
    dist = None if online else distance_between(CAMPUS, (row["store_lat"], row["store_lng"]))
    return store_true_cost(offer, delivery_rules(row["store_id"]),
                           fulfilment=fulfilment, distance_km=dist), dist


def catalogue(Candidate):
    """Real catalogue as Candidates; works with the Phase 3 or Phase 4 class."""
    rows = []
    for index, row in enumerate(DATA["products"], start=1):
        store = STORES[row["store_id"]]
        online = bool(store["online_only"])
        kwargs = dict(
            offer_id=index, product_id=index, product_name=row["name"], brand=row["brand"],
            category=row["category"], subcategory=row["subcategory"],
            colour=None if row["colour"] == "n/a" else row["colour"], size=row["size"],
            is_essential=row["category"] in {"Groceries", "Toiletries"},
            store_id=row["store_id"], store_name=store["store_name"],
            store_type="online" if online else "physical",
            store_latitude=None if online else row["store_lat"],
            store_longitude=None if online else row["store_lng"],
            price=D(str(row["price"])), shipping_cost=D(str(row["shipping_fee"])),
            rating=D(str(row["rating"])), last_updated=NOW,
        )
        try:
            c = Candidate(**kwargs, delivery_available=bool(store["delivery_available"]),
                          collection_available=bool(store["collection_available"]))
        except TypeError:                     # the Phase 3 Candidate
            c = Candidate(**kwargs)
        rows.append((c, row))
    return rows


def evaluate(recommend, Candidate, UserContext, pricer_factory, weights=None, label=""):
    cat = catalogue(Candidate)
    rows_by_id = {c.offer_id: row for c, row in cat}
    candidates = [c for c, _ in cat]
    totals = dict(searches=0, relevance_hit=0, unfulfillable=0, regret_count=0,
                  regret_rands=D("0"), over_ceiling=0, affordability=0)
    regrets = []

    for scen, cfg in SCENARIOS.items():
        budget = {"id": 1, "currency": "ZAR", "remaining_amount": D(cfg["remaining"]),
                  "cycle_start_date": date(2026, 9, 1),
                  "cycle_end_date": date.fromisoformat(cfg["end"]),
                  "survival_threshold": D(cfg["threshold"]) if cfg.get("threshold") else None}
        split = build_split(budget, as_of=TODAY)
        for fulfilment in ("delivery", "collection"):
            ctx_kwargs = dict(remaining_amount=budget["remaining_amount"],
                              daily_limit=split.remaining_today, budget_mode=split.mode,
                              location=CAMPUS, max_distance_km=15.0)
            try:
                ctx = UserContext(**ctx_kwargs, fulfilment=fulfilment)
            except TypeError:
                ctx = UserContext(**ctx_kwargs)
            for query, wanted in QUERIES.items():
                parsed = parse_query(query)
                results = recommend(candidates, ctx, parsed, pricer=pricer_factory(fulfilment),
                                    limit=10, now=NOW, weights=weights)
                totals["searches"] += 1
                if not results:
                    # An empty answer is correct when nothing the student
                    # asked for can honestly be had under their conditions
                    # (survival mode and a kettle; "bread under R25" delivered).
                    possible = any(
                        row["name"] in wanted
                        and (split.mode != "survival" or row["category"] in {"Groceries", "Toiletries"})
                        and corrected_cost(row, fulfilment)[0].fulfilment_available
                        and (parsed.max_price is None
                             or corrected_cost(row, fulfilment)[0].true_cost <= parsed.max_price)
                        for _, row in cat
                    )
                    totals["relevance_hit"] += not possible
                    continue
                top = results[0]
                row = rows_by_id[top.candidate.offer_id]
                cost, _ = corrected_cost(row, fulfilment)

                totals["relevance_hit"] += row["name"] in wanted
                totals["unfulfillable"] += not cost.fulfilment_available

                # Regret: the same product, from a store the student could
                # actually use this way, within their radius, cheaper.
                alternatives = []
                for c, other in cat:
                    if other["name"] != row["name"]:
                        continue
                    alt, dist = corrected_cost(other, fulfilment)
                    if alt.fulfilment_available and within_radius(dist, 15.0):
                        alternatives.append(alt.true_cost)
                best = min(alternatives) if alternatives else cost.true_cost
                if cost.true_cost > best:
                    totals["regret_count"] += 1
                    totals["regret_rands"] += cost.true_cost - best
                    regrets.append(f"{label} {scen} / {fulfilment} / '{query}': "
                                   f"{row['store_name']} R{cost.true_cost} vs R{best}")

                if parsed.max_price is not None:
                    for r in results:
                        c2, _ = corrected_cost(rows_by_id[r.candidate.offer_id], fulfilment)
                        totals["over_ceiling"] += c2.true_cost > parsed.max_price

                # Within one relevance tier, affordable must come first. (Across
                # tiers the right product flagged "over budget" deliberately
                # outranks an affordable substitute — see recommend().)
                seen_unaffordable = {}
                for r in results:
                    tier = getattr(r, "names_query", True)
                    if not r.meets_budget:
                        seen_unaffordable[tier] = True
                    elif seen_unaffordable.get(tier):
                        totals["affordability"] += 1
    return totals, regrets


def phase4_pricer_factory():
    def factory(fulfilment):
        def pricer(candidate, context):
            dist = None if candidate.store_type == "online" else distance_between(
                context.location, (candidate.store_latitude, candidate.store_longitude))
            return store_true_cost(candidate.to_offer(), delivery_rules(candidate.store_id),
                                   fulfilment=fulfilment, distance_km=dist)
        return pricer
    return factory


def print_totals(label, totals):
    n = totals["searches"]
    print(f"\n{label}")
    print(f"  searches evaluated      {n}")
    print(f"  relevance hit           {totals['relevance_hit']}/{n}")
    print(f"  unfulfillable top pick  {totals['unfulfillable']}")
    print(f"  dearer-than-needed pick {totals['regret_count']}  (R{totals['regret_rands']} total)")
    print(f"  results over ceiling    {totals['over_ceiling']}")
    print(f"  affordability inversions {totals['affordability']}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--legacy", action="store_true", help="score with the Phase 3 weights")
    parser.add_argument("--show-regrets", action="store_true")
    args = parser.parse_args()

    from app.recommender import DEFAULT_WEIGHTS, Candidate, UserContext, recommend
    weights = dict(DEFAULT_WEIGHTS) if args.legacy else None
    totals, regrets = evaluate(recommend, Candidate, UserContext, phase4_pricer_factory(),
                               weights=weights, label="legacy" if args.legacy else "tuned")
    print_totals("Phase 3 weights" if args.legacy else "Phase 4 tuned weights", totals)
    if args.show_regrets:
        print("\n".join(regrets) or "  (no regrets)")


if __name__ == "__main__":
    main()
