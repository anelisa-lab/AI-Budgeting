# Phase 4 frontend report — Members 7, 8, 9

Scope: make the UniWallet frontend integrated, correct and demo-ready.
Backend code (`app/`, `sql/`, `tests/`) was **not changed**.

---

## A. Requirements from the group leader

| # | Requirement | Status |
|---|---|---|
| 1 | Frontend integration and bug fixing (requests, responses, loading/error states, navigation) | Done — see C |
| 2 | Search returns results after filters; every filter works, alone and combined; clear filters; paging and sorting don't interfere | Done, tested |
| 3 | Compare: correct item prices, consistent store totals, delivery handled, no invented prices, missing items handled | Done, tested (one backend gap: D2) |
| 4 | A proper Profile page and a Settings page that only offers settings the app can actually keep | Done, tested |
| 5 | Registration residence list covers DUT residences; unsupported data not sent | Done (residence still not sent — backend doesn't accept it) |
| 6 | Maintenance category, consistent across the app | Done in the frontend; no products exist yet (D3) |
| 7 | UI polish pass | Done |
| 8 | Mobile / tablet / desktop | Done, tested at 360, 390, 768, 1024, 1440 px |
| 9 | Mintly → UniWallet | Done; no "Mintly" on any screen |
| 10 | Full journey test | Done — 51/51 browser checks |

## B. Other frontend issues found and fixed

**Search**
1. Category/brand/colour/size must match the catalogue exactly (the backend uses no wildcards), so "Grocer", "2 kg" or "PnP" returned nothing. Category and store are now lists; brand/colour/size suggest from the whole catalogue and snap to its spelling.
2. "Total cost: low to high" was secretly re-ranked, so it wasn't low to high. "Best value for me" is now its own sort.
3. Min price above max price sent a request the backend rejects (400), which blanked the page with "Could not search". Now caught on the field.
4. Results stopped at 100 ("narrow your filters"). "Show more" now pages through every result.
5. "Recommended for you" ignored store/brand filters, so it showed Checkers picks while the student filtered to Shoprite. Now hidden when it can't honour the filters.
6. The same item showed two different prices on one screen (true cost in picks vs listed price in results) with no explanation. Both are now labelled.
7. Typing a search word and then changing a dropdown threw the word away.
8. On phones the filter form pushed results off the first screen. Filters now fold behind a button.
9. The sticky filter panel was taller than the window on desktop, so its bottom (Apply) couldn't be reached.
10. Developer text ("GET /search does not accept a radius parameter…", "availability=any") was shown to students.

**Compare**
11. Out-of-stock listings counted as stocked. A store could be "cheapest" for something it doesn't have.
12. Collecting from a "mixed" store was charged delivery.
13. "List total as chosen" ignored delivery and used the saved price, not today's.
14. The fallback item price charged delivery once per unit.
15. Changing a quantity re-fetched every product's prices.
16. The whole-list total and the item-by-item true cost disagreed with no explanation. Both are now labelled, and the screen explains why they differ.

**Dashboard and budget**
17. "30 days left" sat next to the split's "31 days until your next payout". The day count now comes from the backend.
18. After an overspend, "Spent this period" (capped) disagreed with the recorded purchases. It is now labelled as recorded spending, and the overspend is flagged.
19. Category bars could go past 100% after an overspend.
20. Budget-edit preview showed "new total ÷ period" and ignored money already spent.
21. A budget whose period had already ended could be created.
22. The "Budget saved" badge showed before anything was saved.
23. The % sign sat in front of the number. The Input component now supports a suffix.

**Account, session and settings**
24. A backend outage signed the student out and discarded their session. They now stay signed in and get a retry screen.
25. The shopping list was shared by everyone on the device. A second student on the same computer saw the first student's list. It is now kept per account.
26. "Reduce motion" only worked while the Settings page was open.
27. Profile could overwrite saved preferences with blanks if they had failed to load.
28. Profile only required a non-empty name. It now checks letters and a 100-character limit, and shows server errors on the field.
29. Every new student got a red 404 console error on the dashboard.
30. The "Live API" badge was always shown, even when the backend was down.
31. The offline banner told students to run `uvicorn`.
32. The login page showed a developer note.

**Layout, branding and copy**
33. The navigation overflowed at 1024 px.
34. On phones the active page link was off-screen.
35. A screen-reader label pushed the phone layout 18 px sideways. This regression was found and fixed during testing.
36. Settings overflowed at 360–390 px.
37. There was no favicon, so the browser logged a 404.
38. The landing page claimed "Live prices" and a fixed "R80". The prices are seeded, so the copy is now accurate.
39. Recommendation badges said "Fits today's allowance", but the backend flag means "within your remaining budget", so every item said it fit even with R0 left today.

## C. Fixes implemented (main files)

`src/lib/search.js` (sorts, validation, canonical spelling, filter chips, compare maths), `src/lib/categories.js` (new, single category list), `src/lib/localSettings.js` (new), `src/api/client.js` (catalogue facets, outage detection, no-404 dashboard), `src/api/localList.js` (per-account list), `src/context/*` (session outage handling, day count, recorded spending), `src/screens/Search.jsx`, `Compare.jsx`, `Settings.jsx` (rewritten), `Dashboard.jsx`, `BudgetEntry.jsx`, `Profile.jsx`, `Recommendations.jsx`, `Register.jsx`, `Login.jsx`, `Landing.jsx`, `components/layout/*`, `components/ui/Input.jsx` and `Select.jsx`, `styles/global.css`, `index.html`, plus the contract tests (40 → 52) and the documentation.

## D. Remaining — backend / AI / data team (details in BACKEND_INTEGRATION.md)

1. **No endpoint for the student's location** and no radius on `/search`. The distance filter, proximity ranking and travel cost can't work for real students. (§6)
2. **No whole-basket true cost.** `/true-cost` prices each item as its own order, so store fees can't be applied once per shop. (§10)
3. **No Maintenance products in the catalogue**, and the query parser has no Maintenance words. (§11)
4. `/search?availability=out_of_stock` says "No products are in the catalogue yet". `q=milk 2L` returns nothing. (§12)
5. Residence and student number can't be stored (`RegisterRequest`). (§8)
6. There is no delete for transactions or budgets, and no shopping-list endpoints. (§2–4)
7. The prices are seeded demo data. Live store prices are the AI/backend team's job.

## E. Tests performed

| Test | Result |
|---|---|
| `npm run test:contract` — requests match the real backend routes, plus the Phase 4 logic | **52/52 pass** |
| Browser walkthrough: register → budget → dashboard → spend/overspend → edit budget → search (9 filter combinations, sorts, paging, chips, clear, Maintenance) → add to list → Compare (store totals checked against `/search` data, delivery, quantity) → For you → Profile → Settings → second account → protected route → wrong password → 404 → backend down and recovery → rebrand scan → 5 screen widths → mobile filters | **51/51 pass** |
| Console errors during the walkthrough | Only the ones the tests cause on purpose (409 duplicate email, 401 wrong password, backend stopped) |
| Lint for undefined and unused variables | 0 errors |
| Backend source unchanged | Confirmed by diff |

**How it was run:** npm and PyPI were blocked in the test environment. The **unmodified backend** ran against a real Postgres 16 with the project's schema and seed files. Small test-only stand-ins replaced FastAPI, psycopg2, python-jose, passlib and email-validator. The frontend was bundled with esbuild, using React 19 and a minimal router stand-in, and driven by Playwright/Chromium.

**Still to do before merging:** run `npm install && npm run build && npm run dev` with the real packages and click through once.
