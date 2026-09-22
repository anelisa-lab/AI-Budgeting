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
uvicorn app.main:app --reload --port 4000
```

Server runs on `http://localhost:4000`. `GET /health` should return
`{"status":"ok"}` once it's up. FastAPI also gives you free interactive docs
at `http://localhost:4000/docs` — genuinely useful for the whole team to see
the live API contract and test endpoints without Postman/Thunder Client.

## Running in VS Code (macOS)

1. Open the `budget-backend-python` folder in VS Code
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
| POST   | /budgets                | Yes   | `{ total_amount, cycle_start_date, cycle_end_date, budget_kind?, savings_percentage? }` |
| GET    | /budgets                | Yes   | List all budgets (history) for the user       |
| GET    | /budgets/current        | Yes   | The user's single active budget                |
| PUT    | /budgets/{id}           | Yes   | `{ total_amount?, cycle_end_date? }`           |
| POST   | /budgets/{id}/transactions | Yes | `{ item_name, amount, category?, is_essential? }` — records spend, recalculates `remaining_amount`, flags overspend |
| GET    | /budgets/{id}/transactions | Yes | List transactions for a budget                 |
| GET    | /search                 | Yes   | `?q=&category=&brand=&colour=&size=&store=&min_price=&max_price=&max_shipping_cost=&availability=&essential_only=&sort=&limit=&offset=` |
| POST   | /recommendations        | Yes   | `{ query?, category?, max_price?, fulfilment?, limit?, include_unaffordable?, candidate_pool? }` — ranked offers with true cost, scores and an explanation |
| GET    | /recommendations/history | Yes  | `?limit=` — recent runs and the items they returned |
| POST   | /true-cost              | Yes   | `{ offer_ids[], quantity?, fulfilment?, use_my_location? }` — itemised true cost per offer, cheapest flagged |
| GET    | /true-cost/{offer_id}   | Yes   | `?quantity=&fulfilment=&use_my_location=` — one offer, itemised |
| GET    | /budget-split           | Yes   | Daily allowance for the active budget + a day-by-day schedule |
| POST   | /budget-split/check     | Yes   | `{ amount }` — "can I afford this today?" |
| GET    | /budget-split/{budget_id} | Yes | The same split for one specific budget |

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

`POST /recommendations` ranks offers with six weighted components:

| component | weight | rewards |
|-----------|--------|---------|
| budget_fit | 0.35 | fits today's allowance, then the cycle |
| price_value | 0.20 | cheap relative to the other candidates |
| preference_match | 0.20 | matches saved preferences and the query |
| proximity | 0.15 | close enough to actually go and get |
| rating | 0.07 | other people rated it well |
| freshness | 0.03 | the price was checked recently |

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
"cheap black sneakers under R500 near me size 9"
  -> colour=black, size=9, max_price=500, category=clothing,
     subcategory=footwear, nearby_only=True, sort_hint=price_asc,
     keywords=["sneakers"]
```

Attributes the student names explicitly (category, colour, size) are
**requirements**, not preferences — the ranker drops mismatches rather than
showing a blue hoodie to someone who asked for black. Tuning the weights is
one dict: `DEFAULT_WEIGHTS` in `app/recommender.py`.

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

## Tests

```bash
pytest
```

100 tests covering the recommender, true-cost, budget-split, geo, query
parser and budget arithmetic (`budget_calc`). They are all pure functions, so **no database or `.env` is needed** —
useful for Member 10's QA checklist and for CI. `tests/test_recommender.py`
holds the four whole scenarios from the Phase 3 task (broke student,
true-cost-beats-sticker-price, survival mode, distance).

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
