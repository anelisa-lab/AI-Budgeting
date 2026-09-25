# Backend integration — frontend ⇄ AI-Budgeting

**Replaces `API_CONTRACT.md`,** which described an API that was agreed before
the backend was written and does not match what was built. This document
describes the backend that actually exists, in `AI-Budgeting-main/app`.

Everything below was read off the FastAPI source, not assumed:

| Source file | What it defines |
|---|---|
| `app/main.py` | the router mounts and `GET /health` |
| `app/routers/auth.py` | `/auth/register`, `/auth/login`, `/auth/logout` |
| `app/routers/profile.py` | `/profile/`, `/profile/preferences` |
| `app/routers/budgets.py` | `/budgets`, `/budgets/current`, `/budgets/{id}`, transactions |
| `app/routers/search.py` | `/search` and its query parameters |
| `app/routers/budget_split.py` | `/budget-split`, `/budget-split/check`, `/budget-split/{id}` — wired up, see §1 below |
| `app/schemas.py` | every request and response model |
| `app/security.py`, `app/dependencies.py` | the JWT scheme |
| `sql/schema.sql` | the tables behind all of it |

Also wired up in Phase 3:

| Backend file | Where the frontend uses it |
|---|---|
| `app/routers/recommendations.py` — `POST /recommendations` | the **For you** screen (`/recommendations`) and the "Recommended for you" panel on Search |
| `app/routers/true_cost.py` — `POST /true-cost` | Compare → **Item by item**: each store's offer priced as its own order (item + delivery + store charges + travel) |
| `app/routers/budget_split.py` — `POST /budget-split/check` | Compare → **"Can I afford this today?"**, checked against the cheapest single-shop total |
| `app/routers/profile.py` — `PUT /profile/`, `PUT /profile/preferences` | the **Profile** screen (`/profile`) |

`GET /true-cost/{offer_id}` and `GET /budget-split/{id}` have no screen: there
is no product page or budget-history screen for them to live on.

---

## Conventions that differ from the old contract

These four caused most of the mismatch. They are handled once, in
`src/api/http.js` and `src/api/normalise.js`, and nowhere else.

**1. Base URL has no `/api` prefix.** `app/main.py` mounts every router at the
root, and the backend README starts uvicorn on port 4000. So the base URL is
`http://localhost:4000`, not `http://localhost:8000/api`.

**2. Money arrives as a string.** FastAPI uses Pydantic v2, which serialises
`Decimal` to a JSON **string**: `"total_amount": "1650.00"`. `"1650.00" - 85.5`
is `NaN` in JavaScript, so every money field is coerced to a number at the
boundary by `normalise.js`.

**3. Errors use `detail`, not `{ message, errors }`.**

```jsonc
// HTTPException
{ "detail": "Invalid email or password" }

// Pydantic validation (422)
{ "detail": [ { "type": "...", "loc": ["body", "email"], "msg": "...", "input": null } ] }
```

`http.js` translates both into the `error.message` / `error.fieldErrors` shape
the screens already render, mapping `loc`'s last element onto the form field id
that produced it (`total_amount` → the `amount` input, and so on).

**4. `/profile/` has a trailing slash.** The router is `prefix="/profile"` with
`@router.get("/")`. Calling `/profile` takes a 307 redirect, and a cross-origin
redirect is exactly where a browser drops the `Authorization` header.

---

## Authentication

Stateless JWT, HS256, `sub` = user id, 7-day expiry, sent as
`Authorization: Bearer <token>` (`app/security.py`, `app/dependencies.py`).
No cookies, no server-side session.

| Step | What the frontend does |
|---|---|
| Register | `POST /auth/register` → store `token`, set `user` from `user` |
| Sign in | `POST /auth/login` → same |
| Restore a session | `GET /profile/` with the stored token. **There is no `/auth/me`.** A success means the token is still good; a 401 means it is not |
| Every protected call | `Authorization: Bearer <token>` |
| Sign out | Clear local state first, then `POST /auth/logout` best-effort — the backend cannot invalidate a JWT and says so |
| Expired token | Any 401 from any call fires the handler registered by `AuthContext`, which signs the student out once and shows "your session expired" on the login screen |

---

## Endpoint map

Every frontend feature, the endpoint it calls, and what crosses the wire.

| Frontend feature | Endpoint | Method | Request | Response used |
|---|---|---|---|---|
| Register (`Register.jsx`) | `/auth/register` | POST | `{ name, email, password }` | `{ user, token }` |
| Sign in (`Login.jsx`) | `/auth/login` | POST | `{ email, password }` | `{ user, token }` |
| Sign out (`NavBar.jsx`) | `/auth/logout` | POST | — | ignored (token binned locally) |
| Session restore (`AuthContext`) | `/profile/` | GET | — | `{ id, name, email, created_at }` |
| Edit name | `/profile/` | PUT | `{ name }` | `UserOut` |
| Recommendation preferences (`Search.jsx` ranking) | `/profile/preferences` | GET | — | `{ preferred_categories, preferred_stores, max_distance_km }` |
| Save preferences | `/profile/preferences` | PUT | any subset of those three | `PreferencesOut` |
| Dashboard balance (`Dashboard.jsx`) | `/budgets/current` | GET | — | `BudgetOut`; **404 → no budget**, shown as the empty state |
| Set a budget (`BudgetEntry.jsx`) | `/budgets` | POST | `{ total_amount, cycle_start_date, cycle_end_date, budget_kind, savings_percentage }` | `BudgetOut` |
| Update a budget | `/budgets/{id}` | PUT | `{ total_amount?, cycle_end_date? }` | `BudgetOut` |
| Spending list (`Dashboard.jsx`) | `/budgets/{id}/transactions` | GET | — | `TransactionOut[]` |
| Record a spend | `/budgets/{id}/transactions` | POST | `{ item_name, amount, category, is_essential }` | `{ transaction, budget, overspend_warning, warning_message }` |
| Product search (`Search.jsx`) | `/search` | GET | `q, category, brand, colour, size, store, min_price, max_price, max_shipping_cost, availability, essential_only, sort, limit, offset` | `{ results, count, limit, offset }` |
| Store comparison (`Compare.jsx`) | `/search` | GET | `q=<product name>&availability=any&limit=100` per product | offers grouped by `product_id` |
| Connection banner (`BackendStatus.jsx`) | `/health` | GET | — | `{ status: "ok" }` |

### The form-to-API mapping, in full

Only two conversions exist, both in `src/api/normalise.js`:

| Form field | Backend field | Conversion |
|---|---|---|
| `amount` | `total_amount` | number |
| `payoutDate` | `cycle_start_date` | `YYYY-MM-DD` |
| `periodDays` | `cycle_end_date` | `cycle_start_date + periodDays` |
| `description` | `item_name` | trimmed string |
| `isEssential` | `is_essential` | boolean |

Everything else in the app uses the backend's own field names —
`budget.remaining_amount`, `transaction.item_name`, `offer.product_name` — so
if you can read `app/schemas.py`, you can read this frontend.

---

## Calculations the frontend no longer does

`remaining_amount` belongs to the backend. The previous frontend computed it as
`total − sum(transactions)`, which is a second implementation of what
`budgets.py` already does — and the two disagree the moment a student overspends,
because the server floors remaining at 0 (`CHECK remaining_amount >= 0`) while a
browser subtraction goes negative.

| Figure | Where it comes from now |
|---|---|
| Remaining balance | `budget.remaining_amount`, verbatim |
| Balance after a spend | `response.budget` from the POST, verbatim |
| Overspend warning | `response.overspend_warning` / `warning_message`, verbatim |
| Savings set aside | `budget.savings_amount`, verbatim |
| Amount spent | `(total_amount − savings_amount) − remaining_amount` |
| Search filtering, sorting, paging | SQL in `search.py` |
| Category breakdown | summed from the transaction list — presentation of the log, not a second balance |
| **Daily allowance** | **`GET /budget-split`, verbatim** — falls back to an app-side calc only if that call fails; see §1 below |

---

## Backend dependencies

Nothing in this list is faked in the frontend. Each one is either visibly
marked as unavailable on screen or handled by a device-local store that says so.

### 1. Daily Budget Split — Member 6 — CLOSED

`GET /budget-split` (`app/routers/budget_split.py`) now exists and is wired
up: `BudgetContext` fetches it alongside the budget (`api.budgetSplit.get`,
`src/api/endpoints.js` / `client.js` / `normalise.js`) and refetches it after
every transaction and budget edit, since those all shift the daily figure.
`derived.dailyAllowance` prefers `split.daily_limit` the instant the call
succeeds; the on-screen disclaimer about it being an app-side figure
disappears automatically the same way, because it was already conditioned on
`dailyAllowanceIsFromServer`. `split.mode === 'survival'` also now feeds into
the dashboard's `health` state, matching this endpoint's own documented
intent ("mode: 'survival' turns the UI amber").

If `/budget-split` is unreachable or 404s (no active budget yet), the app
falls back to the exact formula the backend README specifies,
`remaining_amount ÷ days until cycle_end_date`, computed client-side exactly
as before — so the dashboard never breaks, it just quietly loses precision
until the endpoint answers again.

### 2. Delete a transaction

```
DELETE /budgets/{budget_id}/transactions/{transaction_id}   (auth)
  200 -> { transaction: TransactionOut, budget: BudgetOut }
```
Needed because the rubric's CRUD demo includes Delete, and a student who
mistypes an amount currently cannot correct it. The response should return the
recalculated budget for the same reason the POST does. Until it exists, the
dashboard shows the spending list without a remove control and explains why.

### 3. Delete or close a budget

```
DELETE /budgets/{budget_id}                                 (auth)
  200 -> { ok: true }
```
or, better given `budgets.status`, a status change to `cancelled` so history is
kept and `uq_one_active_budget_per_user` is freed for the next cycle. The budget
screen currently offers no delete and says why.

### 4. Shopping list / comparison list

```
GET    /comparison-lists/current                 -> { id, items: [...] }
POST   /comparison-lists/current/items           { offer_id, quantity }
PATCH  /comparison-lists/current/items/{offer_id} { quantity }
DELETE /comparison-lists/current/items/{offer_id}
DELETE /comparison-lists/current
```
`comparison_lists` and `comparison_items` are already in the schema; there is no
router. Until there is, the list lives in `localStorage`
(`src/api/localList.js`) and the Compare screen tells the student it will not
follow them to another device. Every write returns the whole list, so
`ShoppingContext` never has to merge state.

*The frontend is already ready:* swapping `client.js`'s `shoppingList` block to
these endpoints and setting `isLocalOnly` to `false` removes the banner. No
context or screen changes.

### 5. Offers for one product

```
GET /products/{product_id}/offers?availability=any          (auth)
  200 -> { results: SearchResultItem[] }
```
The Compare screen needs "every store that sells this exact product". With no
such route it searches by product **name** and filters on `product_id`, which
costs one request per distinct product and can miss an offer whose product name
differs. `api.search.offersForProducts` is the single function that changes.

### 6. Distance filter and the student's location — backend/AI team

`SearchResultItem` now carries `store_latitude` / `store_longitude`, but a
distance filter still needs the **student's** position, and there is no
endpoint to save one: `user_locations` exists in the schema with no router.
The recommender's proximity score and the travel part of true cost silently
fall back to "unknown distance" for every student created through the app.
Needed:

```
PUT /profile/location   { latitude, longitude } or { residence_area_code }
GET /search?...&radius_km=5    (filter in SQL using user_locations)
```
Until then Search shows "Distance from campus — coming soon", and Profile says
the saved travel distance only counts once a location is on record.

### 7. Store rating — CLOSED

`product_offers.rating` / `rating_count` now exist and `/search` sorts by
`rating_desc`. Search offers "Best rated" and shows the rating on every result.

### 8. Student number and residence at registration

`RegisterRequest` is `{ name, email, password }`. `users.residence_area_code`
exists in the schema but is not exposed, and there is no student-number column.
Res-Mate bulk-buy matching needs residence. Suggested:

```python
class RegisterRequest(BaseModel):
    name: str
    email: EmailStr
    password: str
    student_number: Optional[str] = None      # + users.student_number VARCHAR(20)
    residence_area_code: Optional[str] = None # already in the schema
```
Until then the register form keeps both fields, marks them optional under a
heading that says they are not saved yet, and **does not send them**. Phase 4
expanded the residence list (grouped: DUT Durban residences with the names on
DUT's Student Housing page, Midlands, leased/accredited, not in a residence).
The values in `Register.jsx` are ready to be sent as `residence_area_code`.

### 9. Facet values for the filters

There is still no `GET /search/facets`. Phase 4 builds the store list and the
brand/colour/size suggestions from the **whole** catalogue instead of the page
on screen: `api.search.catalogueFacets()` walks `/search` once per session
(3 requests for 257 offers) and caches the answer. A facets endpoint would
replace that one function.

### 10. Order-level delivery and a whole-basket true cost — backend/AI team

`shipping_cost` is per offer and `POST /true-cost` prices every offer as its
**own** order. There is no way to ask "what does this whole list cost at
Makro, as one order": store fees such as the R3.50 card surcharge are per
order, and free-delivery thresholds depend on the basket total. The frontend
does not re-implement Member 6's calculator to fake it. Instead Compare shows:

- whole-list totals = shelf prices + ONE delivery per store (the largest
  listed `shipping_cost`), labelled "shelf prices" and excluding store fees;
- item-by-item = the backend's true cost, labelled "if bought on its own".

Needed to show one reconciled basket figure:

```
POST /true-cost/basket  { items: [{ offer_id, quantity }], fulfilment }
  -> { stores: [{ store_id, subtotal, shipping, charges[], travel_cost, true_cost, missing: [...] }] }
```

### 11. Maintenance category has no products — data team

Maintenance is now a first-class category in the frontend (`src/lib/categories.js`:
Search, For you, Profile preferences, and spending categories). The seeded
catalogue has **no** products with `category = 'Maintenance'`, so a
Maintenance search or recommendation is empty; the screens say "No Maintenance
items are listed yet" rather than show a blank page. The data team needs to add
real Maintenance listings (bulbs, batteries, extension leads, cleaning and
repair items…) with real prices, and `app/query_parser.py` should map words like
"maintenance", "repair", "bulb", "battery" to it. The frontend deliberately does
not invent products or prices for it.

### 12. Search/recommendation wording and parsing issues — backend team

Found while testing Phase 4 against the real backend:

- `GET /search?availability=out_of_stock` with no other filter answers
  `"No products are in the catalogue yet."` — wrong; `availability` is not in
  `active_filters` in `search.py`. The frontend no longer shows the backend's
  `message` text (it also said "availability=any", which is developer wording).
- `q=milk 2L` returns 0 results although Full Cream Milk (size 2L) exists: the
  parser leaves "2l" in `keywords` (not in `size`), and every keyword must
  appear in the name/brand/category. `q=milk` works.
- `recommendations` `meets_budget` means "within the remaining balance for the
  period", not "within today's allowance" — the frontend badge now says
  "Within your budget" to match.
- The seed has every offer `available`, so out-of-stock handling can only be
  tested with unit tests (it is, in `tests/contract/run.mjs`).

---

## Environment

```bash
# .env.local
VITE_API_BASE_URL=http://localhost:4000
```

`src/api/http.js` is the only file that reads it, and it falls back to
`http://localhost:4000` when unset. It must **not** end in `/api`.

CORS is already `allow_origins=["*"]` in `app/main.py`, so Vite on port 5173
reaches port 4000 without further setup. That should be tightened to the real
frontend origin before the demo — the backend's own comment says so.
