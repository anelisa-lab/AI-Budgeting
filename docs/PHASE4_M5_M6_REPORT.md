# Phase 4 — Integration & Full System Test: Members 5 and 6

Sprint plan, Phase 4 (Sat 26 Sep):

- **Member 5 — AI Dev:** tune recommendation scoring based on integration-test results
- **Member 6 — AI Dev:** validate true-cost & Daily Budget Split numbers across test scenarios

This also covers the fixes carried over from earlier phases: the Compare
screen showing inaccurate prices, the Search filters, and the question of
where prices come from.

---

## 1. Member 5 — recommendation tuning

### The integration test

`scripts/eval_recommender.py` runs the full pipeline (parse → filter → true
cost → budget fit → rank) over Member 9's real catalogue:

- 4 students: broke (R60, 3 days to payout), payday (R2 400, 31 days),
  survival mode (R90 under a R150 threshold), mid-month (R1 200)
- 2 ways of getting it: collect, delivered
- 26 searches, each with the product(s) a careful student would accept

That is 208 searches. Every top pick is judged with the **corrected** true-cost
model, so a recommender can't look good by being scored with its own mistakes.

```bash
python3 scripts/eval_recommender.py                 # what ships
python3 scripts/eval_recommender.py --legacy        # Phase 3 weights only
python3 scripts/eval_recommender.py --show-regrets  # list every overpriced pick
```

### Results

| Metric | Phase 3 code | Phase 4 |
|---|---|---|
| Right product recommended | 201 / 208 | **208 / 208** |
| Top pick from a store that can't serve the student that way | 92 | **0** |
| Top pick dearer than the same product elsewhere | 77 | **3** |
| ...extra those picks cost students, in total | R1 704.78 | **R4.77** |
| Results above a price the student stated ("under R40") | 116 | **0** |
| Unaffordable ranked above affordable (same relevance tier) | 0 | 0 |

`tests/test_phase4_tuning.py` pins these numbers so they can't regress.

### What the test found, and what changed

**1. Proximity double-counted distance.** When collecting, travel is already
in true cost (rands), and proximity (12% of the score) penalised distance a
second time. When delivered, distance costs the student nothing — the
courier fee is already in true cost — yet proximity still carried 12%. Either
way a dearer offer from a nearer store beat a cheaper offer of the identical
product. This was most of the R1 704.78.

*Change:* `FULFILMENT_WEIGHT_SHIFTS` in `app/recommender.py`. Proximity is
0.00 for delivery and 0.04 for collection (a small nudge for time and
effort, which a taxi fare doesn't capture). The weight it gives up moves to
`price_value`. All other weights are unchanged; both modes sum to 1.0.

**2. "sugar" recommended Sugar Beans** in 7 of 8 runs. Both names contain
"sugar" and beans were R27 cheaper. No relevance weight small enough to leave
budget ranking intact could outweigh that.

*Change:* the head-noun rule. A product whose name *ends* in the search word
("White Sugar") names the thing searched for; one that only uses it as a
modifier ("Sugar Beans") gets 0.75 relevance, and products that name the
query rank in a tier above those that don't. Form words ("Bar", "Spread",
"Portions") and pack sizes ("2-Ply") are stripped first, so "Sunlight Soap
Bar" is still soap. The tier sits above affordability on purpose: showing the
right product flagged "R.. over your budget" is better than silently
substituting a different one.

**3. "Under R50" could return R56.** The router over-fetched to 1.15 × the
ceiling and never checked again. *Change:* the ceiling is enforced on true
cost inside `recommend()`; the SQL pre-filters on shelf price (true cost is
never below it, so nothing valid is lost).

**4. Unserviceable stores were recommended** — Takealot for collection,
Shoprite Warwick for delivery. *Change:* dropped (see Member 6, rule 7).

**5. Estimated prices scored as perfectly fresh.** The seed stamped
`last_checked_at = NOW()` on every modelled price. *Change:* freshness is now
scored on `price_verified_at`, which only a real source sets; an estimate
scores 0 and its explanation says "estimated price — not yet confirmed with
the store".

**The 3 remaining overpriced picks** are deliberate: earphones from Game
(1.4 km, walkable) over Makro (5 km, a taxi) to save R1.59. That is the
collection nudge doing what it is for.

---

## 2. Member 6 — true-cost & Daily Budget Split validation

`tests/test_phase4_validation.py` checks invariants that must hold for every
input rather than one hand-picked example each:

- **True cost:** every real offer × collect/delivered × quantity 1/2/5 ×
  walkable/taxi/unknown distance = **4 626 breakdowns**. The lines always add
  up to the cent; shipping is per order; delivery is never charged twice;
  a store is priced only the way it can serve the student; walking distance
  costs nothing; free-delivery thresholds and percentage clamps behave.
- **Daily Budget Split:** 7 balances × 7 cycle lengths × 4 spend patterns ×
  with/without a survival threshold = **392 splits**, plus payout day and a
  lapsed cycle. Today's allowance never promises more than exists; today plus
  every later day never over-allocates the balance; rounding leaves less than
  a cent a day; overspending zeroes today and says so; survival mode is
  exactly "at or below the threshold"; no message ever shows a negative
  amount; "can I afford this" always agrees with the split. The README's CRUD
  demo figures are checked too.

### What it found

**The Daily Budget Split held every invariant. Nothing in it changed.**
(One note: its docstring says left-over cents "land on the last day"; the
code doesn't do that, and doesn't need to — the invariants show the
left-over is always under a cent a day.)

True cost had four real problems, all fixed:

1. **Collecting from an online-only store** was priced as the bare sticker
   price — no courier, no travel — so Takealot won every collection
   comparison. *Fix — `true_cost.py` rule 7:* a store is priced the only way
   it can serve the student, `fulfilment` says which way that was, and
   `fulfilment_available` is False so callers drop it (recommender) or flag it
   (Compare). `cheapest()` ignores such offers.
2. **Shoprite Warwick showed as free delivery.** It doesn't deliver; the
   database had no way to say so. *Fix:* `stores.delivery_available` and
   `stores.collection_available` (migration 003), filled from Member 9's
   store table.
3. **A store 400 m away cost R20 in taxi fare** — more than the loaf it was
   added to. *Fix:* `geo.WALKING_DISTANCE_KM = 1.5`; at or under it travel is
   R0 with a note saying so. Two old tests asserted the R20 and were updated.
4. **Three fees in `seed_store_charges.sql` had no source:** a R3.50 card
   surcharge on every in-store item, a R2 bag levy and a 2.5% online handling
   fee. *Fix:* removed. What remains is each store's delivery fee and
   free-delivery threshold from Member 9's store table, noted as an estimate.

---

## 3. Fixes carried over from earlier phases

### Compare showed inaccurate prices

The browser priced the list itself and couldn't avoid getting it wrong: a
store missing an item was charged *another store's* price for it; delivery
was guessed from the largest item fee; basket-level free-delivery thresholds
were ignored; "split across stores" never paid for the second trip; and the
screen said the prices were "live from the API".

**Now:** `POST /compare/basket` (`app/basket.py`, `app/routers/compare.py`,
`tests/test_basket.py`). One order per store; delivery once per order, with
the threshold tested on the basket; travel once per trip; nothing imputed —
a partial store lists what it's missing; the best plan tries every set of up
to three stores and only suggests splitting when it wins *after* the extra
trip. Offers are looked up by product id, not by re-searching the name.

### The filters didn't work

- **"Low to high" wasn't low to high.** The page silently re-ranked it by
  score. Now "Best match for my budget" is its own sort; every other sort is
  shown exactly as ordered.
- **The budget filter always included delivery.** Bread showed at R54.99, not
  R19.99, and a R30 limit hid it. `GET /search?fulfilment=collection|delivery`
  now filters and sorts on the shelf price when collecting and on price +
  delivery when delivered, and drops stores that can't serve the student that
  way. Search, For you and Compare all default to "I'll collect it".
- **"Essentials only" on For you** filtered the 12 results it got back, so it
  could show an empty page while essentials existed. It's now sent to the
  server (`essential_only`) and applied before the limit.
- A select or checkbox change no longer discards text typed into another
  filter box that hadn't been committed yet.

### Where prices come from

There is **no official public price API** from any South African grocer.
The seed prices are modelled by `docs/seed/build_seed.py` (base price × a
chain's price index × a category modifier) — the dataset says so itself.

`app/price_feed` is how real prices get in:

| Source | Status | How |
|---|---|---|
| `docs/prices/verified_prices.csv` | **Works today** | All 257 store/product rows, prices blank. Fill in from each retailer's own website with the date and URL, then `python -m app.price_feed refresh --provider csv --dry-run`, check, and run without `--dry-run`. |
| RapidAPI "South African Grocery Prices API" (third party; Pick n Pay, Checkers, Woolworths) | **Written, not tested** — no network where it was built | Needs `RAPIDAPI_KEY`. Run `python -m app.price_feed probe --store checkers --query "maize meal"` first to confirm store slugs, the search parameter and field names. |

Every offer carries `price_source` (`seed_estimate` / `live_api` /
`verified_manual`) and `price_verified_at`. A match is applied only when brand
and size agree and it isn't ambiguous; a price that moves more than 60% goes
to review instead. Re-seeding never overwrites a confirmed price. Every screen
labels prices "Estimate" or "Confirmed <date>", and Compare says plainly when
all of them are estimates.

---

## 4. Running it

```bash
# existing database — in this order
psql -U <user> -d <db> -f sql/003_phase4_prices_and_fulfilment.sql
psql -U <user> -d <db> -f mintly-react/docs/seed/seed_backend.sql
psql -U <user> -d <db> -f sql/seed_store_charges.sql

pytest                                   # 177 tests, no database needed
python3 scripts/eval_recommender.py      # the M5 integration metrics
cd mintly-react && npm run test:contract # 43 checks
```

### What was and wasn't verified

- Backend pure logic: 177 tests pass.
- Frontend: 43/43 contract checks; the app compiles.
- The changed routers (`/compare/basket`, `/search`, `/recommendations`) were
  executed against realistic rows with stand-in libraries, which confirmed
  every SQL placeholder matches its parameters. **They have not run against a
  real FastAPI + Postgres** — run the full register → budget → search →
  recommend → compare flow once before merging.
- The RapidAPI adapter has never talked to the live service.

### Numbers for the demo

On the corrected model, an 8-item staples basket (maize meal, bread, milk,
eggs, oil, rice, toothpaste, soap) costs **R289.62 to R344.38** across the five
stores that stock all of it when collected — about **R55** between cheapest
and dearest — and R332.26 to R389.38 delivered. These are still *estimated*
prices; say so.

---

## 5. Files changed (for review and merge)

**Added**

- `app/basket.py`, `app/routers/compare.py` — basket comparison
- `app/price_feed/` (`models`, `matching`, `providers`, `refresh`, `__main__`), `app/routers/prices.py` — live prices
- `sql/003_phase4_prices_and_fulfilment.sql` — migration for existing databases
- `scripts/eval_recommender.py` — the M5 integration evaluation
- `docs/prices/verified_prices.csv` — price template, 257 rows
- `tests/test_basket.py`, `tests/test_price_feed.py`, `tests/test_phase4_tuning.py`, `tests/test_phase4_validation.py`
- this report

**Modified — backend:** `app/recommender.py`, `app/true_cost.py`, `app/geo.py`,
`app/schemas.py`, `app/main.py`, `app/routers/search.py`,
`app/routers/recommendations.py`, `sql/schema.sql`, `sql/seed_store_charges.sql`,
`mintly-react/docs/seed/build_backend_seed.py` and the regenerated
`seed_backend.sql`; tests `test_geo.py`, `test_true_cost.py`,
`test_recommender.py`, `test_scenarios.py` (each change says which old
assertion encoded a bug).

**Modified — frontend:** `src/api/client.js`, `src/api/endpoints.js`,
`src/api/normalise.js`, `src/lib/search.js`, `src/screens/Compare.jsx`,
`src/screens/Search.jsx`, `src/screens/Recommendations.jsx`,
`tests/contract/backend-routes.mjs`, `tests/contract/run.mjs`.

**Modified — docs:** `README.md`, `mintly-react/HANDOVER.md`,
`mintly-react/docs/BACKEND_INTEGRATION.md`.

Nothing in auth, budgets, the dashboard or the Daily Budget Split module was changed.
