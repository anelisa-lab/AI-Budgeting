# Phase 5 — Member 5 & 6 completion notes

## Member 5 — AI Dev: recommendation bugs

The existing Phase 4 recommender regression suite was rerun against the real
seed catalogue:

- 208/208 relevance checks pass.
- 0 unfulfillable top recommendations.
- 0 results exceed a stated true-cost ceiling.
- 0 affordability inversions.
- The remaining 3 collection cases are an intentional 4-cent-per-search
  proximity/time-and-effort trade-off in the Phase 4 design, not an
  unfulfillable or over-budget recommendation.

No change was made to that intentional ranking trade-off.

## Member 6 — AI Dev: true-cost / Budget Split bugs

One integration bug remained in the `/true-cost` router: the SQL query did
not load the stores' explicit `delivery_available` and `collection_available`
flags. That meant the pure calculator's correct fulfilment rules could be
silently replaced by its store-type defaults at the API boundary.

The router now:

1. Loads both store capability flags from `stores`.
2. Passes them through `Offer.from_row()` to `store_true_cost()`.
3. Keeps unfulfillable requested-fulfilment offers visible for explanation,
   but excludes them from `cheapest_offer_id` and `saving_vs_dearest`.

This closes the API-layer mismatch with Member 6's true-cost rules.

## Validation

`pytest -q` → **185 passed**.

`python scripts/eval_recommender.py` → **208/208 relevance, 0 unfulfillable,
0 over-ceiling, 0 affordability inversions**.

`python -m compileall -q app tests` → clean.
