# AI Shopping for Student Budgeting — Backend (Python / FastAPI)

A backend API built to help NSFAS students track their budget, search for
products within their means, and get shopping recommendations that account
for their true cost and time until next payout. Built as a 7-day sprint
project for [module name] at Durban University of Technology.

## Team

| Member | Role |
|--------|------|
| Member 1 | Team Lead / Scrum Master |
| Member 2 (you) | Backend Lead — Auth & Database |
| Member 3 | Backend Dev — Budget Logic |
| Member 4 | Backend Dev — Search & Filtering |
| Member 5 | AI Dev — Recommender |
| Member 6 | AI Dev — True Cost & Daily Budget Split |
| Member 7 | Frontend Lead |
| Member 8 | Frontend Dev |
| Member 9 | Data / Frontend Dev |
| Member 10 | QA / Docs |

Backend Lead: Member 2. This is the Day 1 scaffold — auth + database live here;
Member 3 (budgets), Member 4 (search), Member 5/6 (recommender, true cost,
Daily Budget Split) each add their own `app/routers/*.py` file and register it
in `app/main.py` with `app.include_router(...)`.

## Setup

```bash
python3 -m venv venv
source venv/bin/activate          # macOS/Linux — use venv\Scripts\activate on Windows
pip install -r requirements.txt
cp .env.example .env              # then fill in your local DATABASE_URL and JWT_SECRET
psql -U <user> -d <dbname> -f sql/schema.sql
psql -U <user> -d <dbname> -f mintly-react/docs/seed/seed_backend.sql   # catalogue: 10 stores / 49 products / 257 offers
psql -U <user> -d <dbname> -f sql/seed_store_charges.sql               # AFTER the catalogue — it matches stores by slug
# Existing database from before Phase 4? Run sql/003_phase4_prices_and_fulfilment.sql FIRST.
uvicorn app.main:app --reload --port 4000
```

Then the frontend, in a second terminal:

```bash
cd mintly-react
npm install
npm run dev                       # http://localhost:5173, talks to the API on :4000
```

`APP_TIMEZONE` (default `Africa/Johannesburg`) decides what "today" means for
the Daily Budget Split, for both Python and the Postgres session, so a
late-evening purchase lands on the right day even on a UTC database host.

Server runs on `http://localhost:4000`. `GET /health` should return
`{"status":"ok"}` once it's up. FastAPI also gives you free interactive docs
at `http://localhost:4000/docs` — genuinely useful for the whole team to see
the live API contract and test endpoints without Postman/Thunder Client.

## Running in VS Code (macOS)

1. Open the `AI-Budgeting` repository folder in VS Code
2. Open the integrated terminal (`` Cmd+` ``) and run the setup commands above
3. Install the **Python** extension (by Microsoft) if you haven't — VS Code
   will prompt you to select the `venv` interpreter; choose it so imports resolve
4. If Postgres isn't installed yet: `brew install postgresql@16 && brew services start postgresql@16`, then `createdb budget_app`
5. Run the server with the `uvicorn` command above, or press `F5` with a
   `launch.json` configured for `uvicorn` if you prefer the debugger

## Auth flow

1. `POST /auth/register` → `{ name, email, password }` → returns `{ user, token }`
2. `POST /auth/login` → `{ email, password }` → returns `{ user, token }`
3. Send `Authorization: Bearer <token>` on every protected request
4. `POST /auth/logout` (requires token) → discard the token client-side

## Endpoints implemented here

| Method | Path                    | Auth? | Body / Notes                                  |
|--------|-------------------------|-------|------------------------------------------------|
| GET    | /health                 | No    | Liveness check                                 |
| POST   | /auth/register          | No    | `{ name, email, password }`                    |
| POST   | /auth/login             | No    | `{ email, password }`                          |
| POST   | /auth/logout            | Yes   | —                                               |
| GET    | /profile                | Yes   | Returns id, name, email, created_at            |
| PUT    | /profile                | Yes   | `{ name }`                                     |
| GET    | /profile/preferences    | Yes   | Returns preferred_categories, preferred_stores, max_distance_km |
| PUT    | /profile/preferences    | Yes   | Any subset of the same three fields            |
| POST   | /budgets                | Yes   | `{ total_amount, cycle_start_date, cycle_end_date, budget_kind?, savings_percentage?, survival_threshold? }` |
| GET    | /budgets                | Yes   | List all budgets (history) for the user       |
| GET    | /budgets/current        | Yes   | The user's single active budget, plus its `daily_split` |
| GET    | /budgets/dashboard      | Yes   | `?recent=5` — budget + Daily Budget Split + `health` (warning level, % spent, warnings) + recent transactions |
| PUT    | /budgets/{id}           | Yes   | `{ total_amount?, cycle_end_date?, survival_threshold? }` |
| POST   | /budgets/{id}/transactions | Yes | `{ item_name, amount, category?, is_essential? }` — records spend, recalculates `remaining_amount`, flags overspend and over-today's-allowance, returns the new `daily_split` |
| GET    | /budgets/{id}/transactions | Yes | List transactions for a budget                 |
| GET    | /search                 | Yes   | `?q=&category=&brand=&colour=&size=&store=&min_price=&max_price=&max_shipping_cost=&availability=&essential_only=&sort=&limit=&offset=&page=` — `q` accepts natural language ("bread under R20"); response adds `page`, `total_pages`, `has_more`, `next_offset`, `message`, `parsed` |
| POST   | /recommendations        | Yes   | `{ query?, category?, max_price?, fulfilment?, limit?, include_unaffordable?, candidate_pool? }` — ranked offers with true cost, scores and an explanation |
| GET    | /recommendations/history | Yes  | `?limit=` — recent runs and the items they returned |
| POST   | /true-cost              | Yes   | `{ offer_ids[], quantity?, fulfilment?, use_my_location? }` — itemised true cost per offer, cheapest flagged |
| GET    | /true-cost/{offer_id}   | Yes   | `?quantity=&fulfilment=&use_my_location=` — one offer, itemised |
| GET    | /budget-split           | Yes   | Daily allowance for the active budget + a day-by-day schedule |
| POST   | /budget-split/check     | Yes   | `{ amount }` — "can I afford this today?" |
| GET    | /budget-split/{budget_id} | Yes | The same split for one specific budget |
| POST   | /compare/basket         | Yes   | `{ items: [{product_id, qty}], fulfilment?, use_my_location? }` — the whole list priced per store (delivery once per order, travel once per trip, nothing imputed) plus the cheapest plan (Phase 4) |
| GET    | /prices/status          | Yes   | How many prices are confirmed vs seed estimates (Phase 4) |

`GET /search` also accepts `fulfilment=collection|delivery` (Phase 4): price
filters and sorting use the shelf price when collecting and price + delivery
when delivered, and stores that can't serve the student that way drop out.
`POST /recommendations` also accepts `essential_only`.

## Phase 4 — integration, tuning, validation, real prices

**Read `docs/PHASE4_M5_M6_REPORT.md`.** In short:

- **Member 5:** `scripts/eval_recommender.py` runs 208 searches over the real
  catalogue. Against the Phase 3 code: overpriced top picks 77 → 3 (R1 704.78
  → R4.77), picks from stores that can't serve the student 92 → 0, results
  over a stated ceiling 116 → 0, right product 201 → 208 of 208.
  Fulfilment-aware weights, a head-noun relevance tier, ceiling enforced on
  true cost.
- **Member 6:** `tests/test_phase4_validation.py` checks 4 626 true-cost
  breakdowns and 392 budget splits. The split was correct; true cost priced
  Takealot as collectable, Shoprite Warwick as free delivery, a 400 m walk as
  R20 taxi, and included three unsourced fees. All fixed.
- **Compare** is now `POST /compare/basket`; **Search** sorts and filters on
  what the student will actually pay; **every price** is labelled estimate or
  confirmed.
- **Prices:** no SA grocer has a public price API. `app/price_feed` loads
  confirmed prices from `docs/prices/verified_prices.csv` (works now) or a
  third-party RapidAPI service (written, untested — run `probe` first).

## Phase 3 — backend

- **Token handling (Member 2):** every protected route answers a missing,
  malformed or expired token — or a token for a deleted account — with
  `401` + `WWW-Authenticate: Bearer` (a missing header used to be `403`,
  which the frontend didn't treat as "signed out"). `/profile` and
  `/profile/` both work, so no redirect drops the `Authorization` header.
- **Dashboard + Daily Budget Split in the budget payload (Member 3):**
  `GET /budgets/dashboard`, `daily_split` on `/budgets/current` and on every
  transaction result, `daily_limit_warning` when a purchase fits the cycle
  but not today's allowance. Warning levels come from
  `calculate_budget_health()` in `app/budget_calc.py` (unit-tested).
- **Search edge cases + pagination (Member 4):** `400` with a readable
  `detail` for `min_price > max_price`, unknown `availability` or `sort`;
  blank params are ignored; empty results carry a `message`; `page` and
  pagination metadata were added.

## Schema (for sign-off — see `sql/schema.sql`)

The schema is broader than the Day-1 diagram since it also covers stores,
products/offers, recommendations and community features that later phases
need — but the core four tables match the plan:

- **users**: id, name, email, password_hash, created_at, updated_at (plus phone_number, residence_area_code, email_verified_at)
- **budgets**: id, user_id, total_amount, remaining_amount, savings_percentage, savings_amount, cycle_start_date, cycle_end_date, status, created_at, updated_at
- **transactions**: id, user_id, budget_id, item_name, amount, category, is_essential, store_id (FK, nullable — not a plain text column), created_at
- **preferences**: id, user_id, preferred_categories[], preferred_stores[], max_distance_km, updated_at (plus brand/colour/size/price/shipping preferences)

`cycle_end_date` on `budgets` is the next NSFAS payout date — Member 6 needs
this for the Daily Budget Split calc (`remaining_amount ÷ days until cycle_end_date`).

## For Member 3 (budgets) — done, see `app/routers/budgets.py`

Budget entry, update and the remaining-balance recalculation are implemented.
The overspend-warning rule triggers when a transaction's `amount` is greater
than the budget's `remaining_amount` at the time it's recorded; the
transaction is still logged (so spending history stays accurate) and
`remaining_amount` is floored at 0 rather than going negative, matching the
schema's `remaining_amount >= 0` constraint. See the docstring at the top of
`budgets.py` for the full spec and recalculation pseudocode.

The arithmetic itself lives in `app/budget_calc.py` as pure functions (no
database, no FastAPI) so it's unit-tested in isolation — see
`tests/test_budget_calc.py` (12 tests: zero remaining, zero transaction
amount, negative-input validation, exact-match spending, one-cent-over the
boundary, and budget total increases/decreases including flooring at R0).

## For Member 4 (search) — done, see `app/routers/search.py`

`GET /search` filters `product_offers` joined to `products`/`stores` by
price, colour, size, brand, store, shipping cost and availability. Free-text
`q` uses simple keyword parsing (split on whitespace, ILIKE each token
against name/brand/category) rather than NLP, to keep Day-1 scope small —
see the docstring at the top of `search.py` for the full API contract.

**Phase 2 change:** each result now also returns `subcategory`,
`store_latitude`, `store_longitude`, `rating`, `rating_count` and
`last_updated` (`product_offers.last_checked_at` — how fresh the price is).
Member 5's recommender scores on all five, and the frontend can show the
rating and a "price checked 2 hours ago" label. Only the `SELECT` list
changed; no filters or behaviour were touched.

## For Member 5 (recommender) — done, see `app/recommender.py`

`POST /recommendations` ranks offers with seven weighted components:

| component | weight | rewards |
|-----------|--------|---------|
| relevance | 0.22 | matches the words the student typed |
| budget_fit | 0.30 | fits today's allowance, then the cycle |
| price_value | 0.16 | cheap relative to the other candidates |
| preference_match | 0.13 | matches saved preferences and the query |
| proximity | 0.12 | close enough to actually go and get |
| rating | 0.05 | other people rated it well |
| freshness | 0.02 | the price was checked recently |

Two things make it more than a sort-by-price. It ranks on **true cost**
(Member 6's `store_true_cost`), so a R199 item with a R60 delivery fee loses
to a R240 item with free collection. And `budget_fit` is scored against the
**daily allowance**, not just the balance — something affordable this month
but equal to four days of food is not a good recommendation on day 3.

Every result carries a plain-English `explanation`. That's a requirement, not
decoration: a budgeting app that tells a struggling student "buy this"
without saying why hasn't earned the right to be followed.

Free-text queries go through `app/query_parser.py` — rule-based keyword
parsing, no model and no API key, as agreed with Member 4 in Phase 1:

```
"cheap washing powder under R100 near me"
  -> max_price=100, category=Toiletries, subcategory=Laundry,
     nearby_only=True, sort_hint=price_asc, keywords=["washing","powder"]
```

Attributes the student **states** (colour, size) are requirements: the ranker
drops mismatches rather than showing blue to someone who asked for black. A
category the parser **infers** is only a hint — see below. Tuning the weights
is one dict: `DEFAULT_WEIGHTS` in `app/recommender.py`.

### What Phase 3 changed, and why

Running the recommender against Member 9's real catalogue for the first time
broke it in three ways that the Phase 2 tests could not see, because those
tests used invented candidates with tidy names and categories:

1. **Searches returned the wrong products.** "maize meal" ranked Baked Beans
   first, "sanitary pads" ranked soap. Keyword matching lived entirely in the
   SQL, so the ranker had no idea what had been searched for and could only
   sort by price and distance. Fixed by the new `relevance` component, which
   both ranks and gates — an offer matching none of the student's words is
   dropped rather than ranked low.
2. **Some searches returned nothing at all.** The parser guessed "household"
   for a kettle; the catalogue calls it "Homeware", and the guess was applied
   as a hard filter, so the result was an empty screen. The category
   vocabulary now comes from the dataset, and an *inferred* category can only
   nudge the ranking. Only an explicit `category` on the request filters.
3. **"bread and milk" returned nothing**, because the SQL required every
   keyword to match one row. Keywords are OR-ed now, and ordered by how many
   matched, so the pool cap keeps the most relevant rows rather than the
   cheapest.

Two smaller ones: `"phone"` matched `"Wired Earphones"` (substring matching is
now whole-word), and a word the catalogue doesn't use — a student types
"notebook", the shelf says "A4 Feint & Margin Book" — now falls back to the
inferred category instead of an empty screen, flagged `matched_query: false`
so the UI can say so.

`tests/test_scenarios.py` runs the whole pipeline over the real catalogue for
four students — broke, payday, survival mode, off-campus — so these regress
loudly next time.

## For Member 6 (true cost, Daily Budget Split) — done

**True cost** (`app/true_cost.py`, `POST /true-cost`):

```
true_cost = price x quantity + shipping + store charges + travel
```

The rules, all of which are decisions written down in the module docstring:
shipping is per order not per unit; a `store_charges` row of type `delivery`
is skipped when the offer already has its own `shipping_cost` (never charge
delivery twice); collection means no courier but does mean travel cost;
`free_over_amount` is tested against the subtotal; percentage charges are
clamped to `[min_charge, max_charge]`; everything is `Decimal` so the lines
in the breakdown always add up to the total shown.

**Daily Budget Split** (`app/budget_split.py`, `GET /budget-split`):

```
daily limit = remaining_amount / days to cycle_end_date, rounded DOWN
```

Days are counted **inclusively** — if today is the 20th and payout is the
22nd, that is 3 days of eating, not 2. Rounding down guarantees the days
never allocate more than the budget holds. The split is recalculated on every
read, because the answer changes the moment a transaction is recorded.
`survival_threshold` on the budget flips it into survival mode, which stops
the recommender suggesting non-essentials at all.

Member 3: `build_split()` is importable, so Phase 3's "fold Daily Budget
Split into the budget response" needs no HTTP hop — call it directly from
`budgets.py` with the budget row and a `{date: amount}` map of spend.

**Phase 3 additions.** `tomorrow_limit` is now returned alongside
`daily_limit`: today's allowance is fixed at the start of the day so the
headline number doesn't wobble with every purchase, and `tomorrow_limit` is
the rate from tomorrow, which is what drops when today goes over.
`POST /budget-split/check` answers "can I afford this today?" against the
daily allowance rather than the balance, and reports how many days of
allowance a purchase would eat.

**Member 8 — the response format is documented in
[`mintly-react/docs/BUDGET_SPLIT_CONTRACT.md`](mintly-react/docs/BUDGET_SPLIT_CONTRACT.md)**:
every field, the five states the UI has to render (normal, overspent,
survival, exhausted, payout day) with real payloads for each, and the three
traps — chiefly that `daily_limit` must not be recomputed in the UI, and that
summing `planned_limit` across `days` is not the balance.

## Schema additions for Phase 2 (Member 6)

Three things were added to `sql/schema.sql`:

- `store_charges` — per-store fees that aren't in the listed price
  (delivery, service, card, packaging), which `store_true_cost()` reads
- `products.subcategory` — the recommender scores "toiletries > soap" matches
- `product_offers.rating` / `rating_count` — one of the scoring components

A **fresh** database gets all of this from `sql/schema.sql`. If your dev
database was created from the Day-1 version, run the additive migration
instead of dropping it:

```bash
psql -U <user> -d <dbname> -f sql/002_phase2_recommender.sql   # idempotent
psql -U <user> -d <dbname> -f sql/seed_store_charges.sql       # demo fees
```

`sql/seed_store_charges.sql` fills the new table with realistic placeholder
fees matched by store name, so `/true-cost` has something to add up before
Member 9's real figures land.

### Phase 3 seed fixes (Member 5, in Member 9's generator)

`docs/seed/build_backend_seed.py` was written before the Phase 2 columns
existed and dropped `subcategory` and `rating` on the floor. The effect was
not cosmetic: two of the recommender's seven scoring components were constant
across all 257 offers, so 27% of the ranking weight did nothing. The generator
now writes both, and `seed_backend.sql` has been regenerated.

It also **was not idempotent**, despite the header saying it was. The stores
insert used `ON CONFLICT DO NOTHING` with no unique key for it to fire on, so
every re-run added 10 more stores and re-attached the whole catalogue to them.
Running it twice gave 514 offers and every shop listed twice. It is now keyed
on `external_store_id` with `WHERE NOT EXISTS`, and loading it three times in
a row leaves 10 stores / 49 products / 257 offers.

**If you ran the old file more than once**, your database is already
duplicated. Check with:

```sql
SELECT count(*), count(DISTINCT external_store_id) FROM stores;
```

If those two numbers differ, drop the database and reload `schema.sql` plus
the seed once each.

## Phase 3 frontend wiring

The React app now uses the Phase 3 endpoints rather than only the Phase 2 ones:

- **Dashboard**: loads from `GET /budgets/dashboard` in one call. The status
  banner shows the server's `health.warnings`, and "Safe to spend" renders the
  Daily Budget Split the way `mintly-react/docs/BUDGET_SPLIT_CONTRACT.md`
  describes: the message verbatim, a "left today" bar, the "from tomorrow" rate,
  survival mode, and the allowance-exhausted state. After a purchase it takes
  `daily_split` from the transaction response and shows `daily_limit_message`.
- **Search**: a "Recommended for you" panel calls `POST /recommendations`. It
  shows the true cost, the plain-English explanation, a closest-match notice
  when `matched_query` is false, and survival mode, and links to For you.
- **For you** (`/recommendations`, Member 7): the recommendation-results
  screen — cards with rank, true cost, explanation and budget fit; category,
  max-price, delivery/collection and "over today's allowance" filters; sort by
  rank, true cost, distance or rating.
- **Daily Budget Split component** (`src/components/budget/DailyBudgetSplit.jsx`,
  Member 8): the dashboard's "Safe to spend" card, including the next 7 days
  of the schedule.
- **Compare** (Member 9): one "Getting it" choice (collect / deliver) drives the
  whole page; "Item by item" prices each store's offer with `POST /true-cost`;
  "Can I afford this today?" calls `POST /budget-split/check` on the cheapest
  single-shop total.
- **Profile** (`/profile`): name, preferred categories and stores, and travel
  radius — the preferences the recommender scores on.
- **Budget**: a survival-mode threshold ("Broke Week Mode") can be set when
  creating or editing a budget.
- `npm run test:contract` covers the new calls (40 checks).

### Phase 3 search fix

A colour or size that the parser pulls out of free text is now also matched
against the product **name**. Before, "Brown Bread", "White Bread" and "Full
Cream Milk" returned nothing from `/search` and `/recommendations`, because
"brown"/"white"/"cream" were required as `products.colour`, which is NULL for
food. That also broke Compare, which looks offers up by product name. An
explicit `?colour=` / `?size=` filter is still strict. The parser also no
longer reads the "r" that ends "paper 2-ply" as "R2".

## Tests

```bash
pytest                            # backend, no database needed
cd mintly-react && npm run lint && npm run test:contract && npm run build
```

177 tests covering the recommender, true-cost, budget-split, geo, query
parser, budget arithmetic (`budget_calc`), basket comparison and the live
price layer (Phase 4 added `test_basket.py`, `test_price_feed.py`,
`test_phase4_tuning.py` and `test_phase4_validation.py`). They are all pure functions, so
**no database or `.env` is needed** — useful for Member 10's QA checklist and
for CI.

`tests/test_scenarios.py` is the Phase 3 deliverable for Member 5: the whole
pipeline — parse, filter, true cost, budget fit, rank — run against **Member
9's real catalogue** (read straight from
`mintly-react/docs/seed/products.json`) for four students in different
situations: broke with three days to payout, payday with a full allowance,
survival mode, and living off-campus. Every Phase 3 bug came from real data
rather than invented rows, which is why these tests use the real thing.

## Project structure

Pure logic lives in `app/*.py` and all database access lives in
`app/routers/*.py`. That split is why the suite runs without Postgres, and
it's worth keeping.

```
app/
  main.py            # FastAPI app, mounts all routers
  database.py        # Postgres connection helper
  security.py        # password hashing + JWT helpers
  dependencies.py    # get_current_user_id — use as a route dependency
  schemas.py         # Pydantic request/response models
  geo.py             # distance + travel-cost helpers      (Member 5/6)
  query_parser.py    # free text -> constraints            (Member 5)
  recommender.py     # weighted scoring engine             (Member 5)
  true_cost.py       # store_true_cost()                   (Member 6)
  budget_split.py    # Daily Budget Split algorithm        (Member 6)
  budget_calc.py     # budget/transaction arithmetic       (Member 3)
  routers/
    auth.py
    profile.py
    budgets.py
    search.py
    recommendations.py                                  #  (Member 5)
    true_cost.py                                        #  (Member 6)
    budget_split.py                                     #  (Member 6)
tests/
  test_geo.py  test_query_parser.py  test_recommender.py
  test_true_cost.py  test_budget_split.py  test_budget_calc.py
sql/
  schema.sql                    # full schema, for a fresh database
  002_phase2_recommender.sql    # additive migration for an existing one
  seed_store_charges.sql        # demo fees for the new store_charges table
```

## License

This project was built for academic purposes as part of coursework at DUT.
