# Phase 5 — closing the integration gaps

Scope: the gaps the Phase 4 review listed as "backend-side" (section 2) and
"partly built" (section 3). Each one is fixed end to end: database, API,
screen and tests.

## What changed

| Gap | Fix | Where |
|---|---|---|
| No way to save where a student is — distance filter, "near me", proximity ranking and taxi fares could never work | `GET/PUT/DELETE /profile/location` on the Phase 1 `user_locations` table. Profile → **Where you are**: pick a DUT campus (approximate campus-area points; Steve Biko is the seed's own origin) or **Use my current location** (browser). `geo.fetch_user_location()` was already read by search, the recommender, true cost and Compare, so all of them now use it. | `app/routers/profile.py`, `src/screens/Profile.jsx`, `src/lib/campuses.js` |
| Distance filter was a "coming soon" placeholder | `GET /search?max_distance_km=N` (stores within N km; online-only stores have no address, so they drop out), `sort=distance`, `distance_km` on every result, and "near me" in the query uses the student's radius preference (or 15 km). A 400 says "Set your location in Profile…" when there is none. Search → **Distance** filter (walking distance 1.5 km … 25 km), **Nearest store first** sort, "0.5 km away" on each result. | `app/routers/search.py`, `src/lib/search.js`, `src/screens/Search.jsx` |
| No Maintenance products; parser had no Maintenance words | 6 products / 26 listings (LED bulb, AA batteries, duct tape, super glue, padlock, extension cord) added through Member 9's generator, priced the same way as the rest (base price × chain index × the chain's Homeware multiplier) and labelled as estimates. Appended at the end, so every existing product and listing id is unchanged. Parser words: bulb, batteries, tape, glue, padlock, lock, extension, cord, fix, repair, maintenance. | `mintly-react/docs/seed/build_seed.py` → regenerated `products.*` and `seed_backend.sql`; `app/query_parser.py` |
| Shopping list only in the browser (didn't follow the student) | `/shopping-list` (GET, POST items, PUT/DELETE item, DELETE all) on the Phase 1 `comparison_lists` / `comparison_items` tables, plus `qty` and `price_when_added` (migration 005). Every response is joined to today's offer. A list an earlier build saved in the browser is uploaded once, then cleared. | `app/routers/shopping_list.py`, `sql/005_phase5_shopping_list.sql`, `src/api/client.js` |
| No delete for spends or budgets | `DELETE /budgets/{id}/transactions/{tid}` and `DELETE /budgets/{id}`. The money from a deleted spend goes back, **capped by the ledger** so undoing part of an overspend can't create money, and a deletion never lowers what is left (`budget_calc.calculate_transaction_removal`, 5 unit tests). Dashboard: ✕ on each spend. Budget: **Delete budget**. | `app/budget_calc.py`, `app/routers/budgets.py`, `src/context/BudgetContext.jsx` |
| `PUT /profile` didn't return residence/student number; they couldn't be edited | `PUT /profile` accepts both (omitted = unchanged, `""` = clear) and returns them. Profile edits them. | `app/routers/profile.py`, `src/screens/Profile.jsx` |
| API accepted requests from any website | `CORS_ORIGINS` (comma-separated), default the Vite dev/preview servers. | `app/main.py`, `.env.example` |
| History saved but never shown (slide 13, "Personalisation Profile") | For you → **Your recent searches**: each past search once, newest first, with its top pick; tap to repeat. **Clear** calls the new `DELETE /recommendations/history` (slide 17: personal data used only for authorised functions). | `app/routers/recommendations.py`, `src/screens/Recommendations.jsx` |

### Bug found while testing

**For you dropped a search typed straight after opening the page.** The
submit button was disabled while the default picks loaded, and a browser
won't submit a form with Enter while its submit button is disabled — so the
student's search silently did nothing (4 times in 5 in testing). The button
now stays enabled (`runSearch` already ignores a stale answer). 5 of 5 after
the fix.

## Still open

- **Store prices are modelled estimates.** Nothing here invents prices; the
  RapidAPI adapter (`app/price_feed`) still needs an API key and a first real
  run, or the CSV in `docs/prices/verified_prices.csv` filled in by hand.
- **Standout features beyond the agreed MVP** (slides 18–19): No-Data/SMS
  mode, Find Nearby Store with directions, Res-Mate bulk-buy, Res spending
  comparison, Cooling-off period. The sprint plan scoped the MVP plus Daily
  Budget Split.

## Existing database

```bash
psql -U <user> -d <db> -f sql/005_phase5_shopping_list.sql
psql -U <user> -d <db> -f mintly-react/docs/seed/seed_backend.sql   # safe to re-run; adds Maintenance
```

Both are safe to run more than once. A new database gets everything from
`sql/schema.sql` + the seed.

## Verified against real FastAPI + Postgres 16

- `pytest`: 183 passed (the recommender evaluation is unchanged: 208/208
  right product, 3 slightly dearer picks, 0 over a stated ceiling).
- `npm run test:contract`: 61/61, with the route table cross-checked against
  the live OpenAPI schema.
- `npm run lint` and `npm run build` clean.
- Playwright walkthrough, 29 checks, passed 3 runs in a row: everything from
  Phase 4 plus campus location → distance filter + nearest first →
  Maintenance search → delete a spend (remaining restored) → recent searches
  repeat → the list appears in a second browser → delete the budget; and no
  horizontal scroll on 7 screens at 360, 390, 768, 1024 and 1440 px.
