# UniWallet — Phase 4 handover and rubric map

## Phase 4 (Members 7, 8, 9) — what changed

- **Rebrand:** Mintly → UniWallet on every screen, title, toast and label.
  Old `mintly.*` storage keys migrate automatically. The folder is still
  `mintly-react` because the backend README/tests point at that path.
- **Search:** category and store are real choices (store list from the live
  catalogue); brand/colour/size suggest from the whole catalogue and snap to
  its spelling ("2 kg" → "2kg", "albany" → "Albany"); min > max is caught on
  the field; "Best value for me" is now its own sort, so "low to high" really is
  low to high; "Show more" pages through every result (no 100 cap); active
  filters are removable chips; recommendations hide when a filter they cannot
  honour is on; filters fold behind a button on phones.
- **Compare:** only in-stock offers count; no store gets a made-up total;
  collecting from any walk-in store has no delivery fee; "your list as chosen"
  uses today's prices plus one delivery per store; changing a quantity no
  longer re-fetches every price; the whole-list vs item-by-item difference is
  explained on screen (backend dependency §10).
- **Profile/Settings:** Settings shows where each setting lives (account vs
  this device), sign-out, budget shortcut, real connection status; reduce
  motion now actually persists; Profile guards against overwriting
  preferences that failed to load, validates the name, includes Maintenance.
- **Maintenance:** one category list (`src/lib/categories.js`) used everywhere;
  empty Maintenance searches explain that no products are listed yet (data
  dependency §11).
- **Registration:** residences grouped, DUT Durban names match DUT's housing
  page; still not sent (backend does not accept it).
- **Also fixed:** the shopping list is now per account (a shared computer no
  longer shows the last student's list); a backend outage no longer signs the
  student out; new students no longer trigger a 404 console error; days-left
  matches the backend split; budget edits preview correctly; budgets whose
  period already ended are rejected; developer instructions no longer appear to
  students; nav no longer overflows at 1024px or on phones.

Tests: `npm run test:contract` → **52/52**. Browser walkthrough (register →
budget → dashboard → search/filters → recommendations → compare → profile →
settings, plus mobile/tablet/desktop) → **51/51** against the real backend code
and a seeded Postgres. See "Test criteria" below for how that was run.

---

# Presentation 2 — handover and rubric map

Use this to prepare the demo. It says where every mark is earned and what to
click to show it.

**What changed since the last version:** the frontend now runs against the real
FastAPI backend. There is no mock API. Everything in the CRUD script below is a
real HTTP request to `AI-Budgeting-main`, hitting Postgres. That changes some of
the answers you give, so read the "questions you will be asked" section again
even if you read it before.

---

## Before the demo — 3 things, in this order

```bash
# 1. backend up
cd AI-Budgeting-main && source venv/bin/activate
uvicorn app.main:app --reload --port 4000          # /health must return {"status":"ok"}

# 2. catalogue seeded — WITHOUT THIS, SEARCH RETURNS NOTHING
psql -U <user> -d budget_app -f <frontend>/docs/seed/seed_backend.sql

# 3. frontend up
npm install && npm run dev
```

If the backend is down, a red banner says so at the top of every screen. That
is deliberate — but do not let a marker see it. Check `/health` first.

---

## The rubric, and where each line is evidenced

### 1. UI & UX — /25

| Criterion | Where it lives | What to show |
|---|---|---|
| Look and feel | `styles/tokens.css` — one palette, two typefaces, a 1.25 type scale | Open any two screens side by side. Same spacing, same radii, same colours. |
| Quality of interaction and navigation | `App.jsx`, `NavBar.jsx`, `ProtectedRoute.jsx` | Sign out, try to open `/dashboard` directly — you are bounced to login **and returned to `/dashboard`** after signing in. |
| **Quality of feedback** | `ToastContext`, `Alert`, `Button loading`, `Field error`, `BackendStatus` | Submit the register form empty → per-field errors, first one focused. Record a spend bigger than your balance → the server's own overspend warning appears as a red alert. Stop uvicorn → a banner names the URL it cannot reach. |
| Understandability | `Field`, `Badge`, icons + text labels | Every icon has a text label beside it. Nothing relies on an icon alone. |
| **Consistency** | `components/ui/` + tokens | There is exactly one `<Button>`. Grep the repo for `#` hex codes in components — the only ones are the ten store colours on Compare, and they are decorative. |

**The strongest single thing to say:** colour never carries meaning on its own.
When the budget runs out the bar turns red *and* the banner text changes *and*
the wording changes. That is a deliberate accessibility decision.

### 2. Evaluation / Reliability — /20 + /10

| Criterion | Evidence |
|---|---|
| Functionality | Seven screens, all working against the live API: register → budget → dashboard → search → compare. |
| **Validation and acceptance** | Two layers, and say both. `lib/validation.js` catches what it can before a request is made. `src/api/http.js` translates the backend's own Pydantic 422 onto the exact field that caused it — so the server's rules are enforced too, not just the browser's. Demo: type `abc` into the student number field; then try to register with an email that already exists and watch a real 409 land on the email field. |
| Non-functionality | Accessibility (ARIA wiring in `Field`, focus management, `prefers-reduced-motion`), performance (filtering and paging happen in SQL, not in the browser), resilience (a dead backend, an expired token and a network failure each have their own visible handling). |
| Scalability | Search is server-side and paged — the catalogue can grow past the 257 listings without a frontend change. `src/api/endpoints.js` isolates every URL, so a backend change is a one-file edit. |
| Testing for non-functional requirements | `npm run test:contract` — 30 automated checks that the frontend cannot send a request the backend would reject. Keyboard-only pass on every form; layout verified at 390px, 768px, 1280px. |
| Testing criteria | The table below. |

**Run `npm run test:contract` in front of the markers.** It takes two seconds,
needs no backend, and it is the most direct evidence that the frontend and
backend genuinely agree — which is the thing this phase was about.

### 3. Database — /10

| Criterion | Evidence |
|---|---|
| Database design and data integrity | `AI-Budgeting-main/sql/schema.sql` — 24 tables. Point at the constraints doing real work: `remaining_amount >= 0`, `savings_amount <= total_amount`, `uq_one_active_budget_per_user`, and `product_offers.total_cost` as a GENERATED column so it can never disagree with price + shipping. |
| **Test the CRUD** | Walk it live — see the script below. Every step is an HTTP request to the API and a row in Postgres. |

**CRUD demo script — do this exactly:**

| Operation | Action | Endpoint it hits |
|---|---|---|
| **Create** | Register an account | `POST /auth/register` |
| **Create** | Set a budget of R1 650, 30 days, 10% aside | `POST /budgets` |
| **Read** | Dashboard shows R1 485 left and the daily figure | `GET /budgets/current` |
| **Create** | Record a spend of R85.50, "Bread and milk" | `POST /budgets/{id}/transactions` |
| **Read** | It appears in Recent spending; "Where it went" updates | `GET /budgets/{id}/transactions` |
| **Update** | Change the budget to R1 940 | `PUT /budgets/{id}` |
| **Read** | The balance shifts by R290 — spending already recorded is kept | `GET /budgets/current` |
| **Read** | Search "maize", add two items, open Compare | `GET /search` |

Open the browser's Network tab while you do it. Every row above is visible as a
real request, and the R1 485 is the **server's** number, not the browser's.

> **Delete is the honest gap.** The backend has no `DELETE` route for a budget
> or a transaction, so the app does not offer one — it says why, on screen, in
> both places. If a marker asks for Delete, show them that message and
> `docs/BACKEND_INTEGRATION.md` §2 and §3, which specify the two endpoints with
> their request and response shapes. "We identified it, specified it and did not
> fake it" is a better answer than a button that lies.

### 4. Value — /10

| Criterion | Evidence |
|---|---|
| Useful in daily practice | The comparison screen: the same list priced at every store that stocks it, from live API data. A representative basket varies by **more than R80** between cheapest and dearest — against a weekly food allowance of about R385. |
| Distinct characteristics of mobile platforms | Mobile-first responsive layout; native `<select>` so phones open the OS picker; `inputMode="numeric"` and `"decimal"` so the right keypad appears; touch targets ≥ 44px; `viewport-fit=cover` and safe-area insets for notched phones. |

**Open the demo on a phone during the presentation.** That is the fastest way to
bank the mobile-platform mark.

### 5. Presentation skills — /25

Innovative and creative · ownership and understanding · answering questions.
The next section is for this one.

---

## Questions you will be asked, and the honest answers

**"Is the frontend actually connected to the backend?"**
Yes — and this is the thing to lead with, because it was the gap last time.
Show the Network tab. Then show `src/api/endpoints.js`: one function per real
backend route, each annotated with the file it was read from. Then run
`npm run test:contract`.

**"Where do the prices come from?"**
Collected manually in September 2026 from published South African retail
pricing, Durban, and loaded into the backend's `products` and `product_offers`
tables by `docs/seed/seed_backend.sql`. They are indicative and they go stale.
There is no public price API for SA supermarkets — production needs a data
partnership, scraping under each retailer's terms, or crowd-sourced entries from
students. Say this plainly; a made-up answer here is worse than the limitation.

**"Is this actually AI?"**
It is a transparent weighted ranker — `rank()` in `lib/search.js` — that scores
each result on total cost, budget fit, delivery cost, availability and the
student's saved preferences, and returns the reason in one sentence. That is
deliberate: a student deciding how to spend tight money deserves to know *why*
something was recommended, which a black-box model cannot give them. It is also
honest — we have no training data yet. The architecture swaps in a trained
ranker by replacing that one function.

**"How does the distance filter know where I am? The synopsis says 25 km."**
Since Phase 5 the student saves a location on Profile → *Where you are*: a DUT
campus, or their device's location (`PUT /profile/location`). `/search` then
takes `max_distance_km` (up to 25 km) and `sort=distance`, and every result
says how far away the store is. The same location feeds the recommender's
proximity score and the taxi fares in true cost and Compare. Without one, the
filter says to add a location instead of guessing.

**"Is the shopping list saved to my account?"**
Yes, since Phase 5: `/shopping-list` stores it in `comparison_lists` /
`comparison_items`, so it follows the student to any device. A list an
earlier build saved in the browser is uploaded once on the next sign-in.
Only `client.js` changed; no screen did.

**"Where does the daily spend figure come from?"**
`GET /budget-split` — Member 6's Daily Budget Split algorithm, called live.
`BudgetContext` fetches it alongside the budget and refetches it after every
spend or budget edit, since those both shift the number. If that call ever
fails, the dashboard falls back to `remaining_amount ÷ days until the next
payout`, computed in the app and labelled as such — but in a normal demo you
will not see that label, because the real endpoint is answering.

**"What happens if two students in the same res both want the same thing?"**
That is Res-Mate bulk-buy matching from the Task 1 deck. Residence is collected
at registration but `RegisterRequest` will not accept it yet, so the field is
marked optional and not sent — §8 specifies the change. Not built.

**"What is the weakest part?"**
Say it first, before you are asked: "cheapest" still ignores what it costs to
*get* there. A store 5 km away that saves R20 is not cheaper if the taxi is R26.
We cannot even attempt it until `/search` returns store locations, which is the
same gap as the distance filter — and it is the feature we would claim as our
own contribution beyond the brief.

---

## Test criteria — what we checked

Automated, `npm run test:contract` (no backend needed):

| # | Test | Result |
|---|---|---|
| 1 | Register sends exactly `{ name, email, password }` — nothing the API would drop | Pass |
| 2 | A 401 from login lands on the password field | Pass |
| 3 | A 409 from register lands on the email field | Pass |
| 4 | Pydantic's 422 is mapped onto the form field that caused it | Pass |
| 5 | Session restore calls `GET /profile/` with the trailing slash | Pass |
| 6 | `GET /budgets/current` answering 404 means "no budget", not an error | Pass |
| 7 | A 500 on the same call is **not** swallowed as "no budget" | Pass |
| 8 | Decimal-as-string (`"1650.00"`) is coerced to a number | Pass |
| 9 | The budget form's payout date + period map onto the cycle dates, and round-trip | Pass |
| 10 | `PUT /budgets/{id}` sends only the two fields it accepts | Pass |
| 11 | A spend sends `item_name`, not `description` | Pass |
| 12 | The server's overspend verdict and floored balance are used verbatim | Pass |
| 13 | `/search` is sent only parameters the backend declares | Pass |
| 14 | Only the three sorts `search.py` implements are ever sent | Pass |
| 15 | Filters survive a round-trip through the URL | Pass |
| 16 | The ranker re-orders but never filters | Pass |
| 17 | A store is only "complete" when it stocks every line | Pass |
| 18 | One delivery charge per store, not one per item | Pass |
| 19 | An unreachable backend gives a readable message, not a raw TypeError | Pass |
| — | **40 checks in total** | **40/40** |

Against a real seeded Postgres, using `search.py`'s own SQL:

| # | Test | Expected | Result |
|---|---|---|---|
| 20 | Seed loads | 10 stores, 49 products, 257 offers | Pass |
| 21 | Empty search | 257 available offers, cheapest first | Pass |
| 22 | Search "maize" | 6 matches | Pass |
| 23 | "rice" with a R40 ceiling | 0 — the cheapest rice is R41.49 | Pass |
| 24 | No-delivery-fee filter | 34, all `shipping_cost = 0` | Pass |
| 25 | Essentials only | 201, all `is_essential` | Pass |
| 26 | Store = Shoprite | 34 | Pass |
| 27 | Sort high→low | order reverses | Pass |
| 28 | Availability excludes out-of-stock rows | 245 of 257 | Pass |
| 29 | Combined: essentials + free delivery + under R50 | 28, all three hold | Pass |
| 30 | A budget of R1 650 with 10% aside | remaining R1 485, savings R165 | Pass |
| 31 | A second active budget | rejected by `uq_one_active_budget_per_user` | Pass |
| 32 | An overspend | balance floors at 0, never negative | Pass |

Manual, in the browser:

| # | Test | Expected | Result |
|---|---|---|---|
| 33 | Production bundle of every module | no errors | Pass — bundled with esbuild (Vite unavailable offline) |
| 34 | Full click-through against the backend | all screens, 51 scripted checks | **Pass — 51/51** (Phase 4) |

> **How 33 and 34 were run (Phase 4), and what is still to do.** The Phase 4
> environment could not reach npm or PyPI either. So the **unmodified backend
> code** was run under uvicorn against a real Postgres 16 loaded with
> `schema.sql`, `seed_backend.sql` and `seed_store_charges.sql`, using small
> test-only stand-ins for the packages that could not be installed (FastAPI,
> psycopg2, python-jose, passlib, email-validator). The frontend was bundled
> from `src/` with esbuild, with React 19 and a minimal react-router stand-in,
> and driven by Playwright/Chromium. **Before merging, Anelisa should still run
> `npm install && npm run build && npm run dev` with the real packages and click
> through once** — the code did not change for that, but it is the one step
> not done with the exact package versions.
---

## Splitting the demo across the group

The rubric penalises presentations where one person does everything.

| Who | Shows | Minutes |
|---|---|---|
| M7 | Design tokens, the component library, the route map, responsive behaviour | 3 |
| M8 | Register → validation → budget entry → the live preview → dashboard → the overspend warning coming back from the server | 4 |
| M9 | Search against the live API → filters → Compare → what the backend cannot do yet and why | 4 |
| M2/M3 | `endpoints.js` and the Network tab: frontend request → FastAPI route → Postgres row | 3 |
| Anyone | `npm run test:contract`, then the CRUD script | 2 |

Whoever is not speaking should be ready to answer on their own files. "I do not
know, that was someone else's part" costs marks under **Ownership and
understanding** — and it is the single most common way groups lose them.
