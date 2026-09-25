# UniWallet — frontend

AI Shopping for Budgeting. Helping NSFAS-funded DUT students budget their
allowance and find the cheapest place to buy what they need.
SODM401 / SFEN301, Durban University of Technology.

React 18 + Vite. **It talks to the real FastAPI backend in `AI-Budgeting-main`.
There is no mock mode.**

---

## Running it

The backend has to be up first — every screen reads from it.

```bash
# 1. the backend (in the AI-Budgeting-main checkout)
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env                      # fill in DATABASE_URL and JWT_SECRET
psql -U <user> -d budget_app -f sql/schema.sql
uvicorn app.main:app --reload --port 4000

# 2. seed the catalogue, or /search returns nothing
psql -U <user> -d budget_app -f <this repo>/docs/seed/seed_backend.sql

# 3. the frontend (here)
npm install
cp .env.example .env.local                # defaults to http://localhost:4000
npm run dev
```

`GET http://localhost:4000/health` should return `{"status":"ok"}`. If it does
not, the app says so in a banner at the top of every screen rather than failing
five different ways.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on 5173 |
| `npm run build` | production build |
| `npm run test:contract` | **the contract test** — see below. No backend needed |
| `npm run seed:backend` | regenerate `docs/seed/seed_backend.sql` from the dataset |

---

## How the frontend talks to the backend

Four files, in a deliberate order. Nothing above them constructs a request.

```
screens / contexts
        ↓
src/api/client.js        what the app wants to do  ("get the current budget")
        ↓
src/api/endpoints.js     one function per REAL backend route — the URLs live here
        ↓
src/api/http.js          fetch, the Bearer header, FastAPI's error envelope
        ↓
        the backend
```

`src/api/normalise.js` sits alongside them and does exactly two things: coerce
Pydantic's Decimal-as-string into real numbers, and convert between the budget
form's two questions and the backend's cycle dates.

**If the backend changes, `endpoints.js` is the file to change.** Every path,
method, body key and query parameter in it is annotated with the backend source
it came from.

Read **`docs/BACKEND_INTEGRATION.md`** before touching any of this. It maps
every screen to its endpoint, explains the four conventions that differ from the
old contract, and lists — honestly — the ten things the backend cannot do yet.

---

## The contract test

```bash
npm run test:contract
```

Zero dependencies, no build, no running backend. It imports the real API layer
and swaps in a `fetch` that checks every outgoing request against a transcription
of the backend's routes: the path must exist, the method must match, protected
routes must carry `Authorization: Bearer`, the body may only contain keys the
Pydantic model declares, and the query string may only contain parameters the
route declares. It then answers the way FastAPI would — Decimal as a string
included — and asserts the frontend reads the response correctly.

A failure means the frontend and the backend have drifted apart. Run it whenever
either side changes.

---

## Project layout

```
src/
  api/
    client.js        the app-facing API — the only thing screens import
    endpoints.js     one function per real backend route
    http.js          transport, Bearer auth, FastAPI error translation
    normalise.js     Decimal coercion + the form↔API mapping
    localList.js     the shopping list, device-local until the backend has one
  context/
    AuthContext      the JWT, the signed-in user, stored preferences
    BudgetContext    the active budget and its transactions
    ShoppingContext  the shopping list
    ToastContext     transient confirmations
  screens/           Landing, Login, Register, Dashboard, BudgetEntry, Search, Compare
  components/
    ui/              the component library — one Button, one Card, one Field
    layout/          AppShell, NavBar, ProtectedRoute, BackendStatus
  lib/
    search.js        search params, the ranker, the comparison maths (pure functions)
    validation.js    form rules, each returning a message that says how to fix it
    format.js        money, dates, distances — formatted in one place
  styles/            tokens.css (the design system) + global.css
docs/
  BACKEND_INTEGRATION.md   ← start here
  SEED_DATA_CONTRACT.md    the dataset's field definitions
  WIREFRAMES.md
  seed/                    the dataset and the SQL that loads it into the backend
tests/contract/            the contract test
```

---

## Things worth knowing

**The backend owns the arithmetic.** `remaining_amount` comes from the API and
is never recomputed here. When a spend is recorded, the response carries the
recalculated budget and the server's overspend verdict, and both are used
verbatim. The one exception — the daily allowance — is labelled on screen and
listed as a backend dependency.

**Search happens in SQL.** `GET /search` filters, sorts and pages. Only the
default sort, "Best value for me", re-orders each page with a transparent
weighted score (`rank()` in `lib/search.js`); every other sort is the backend's
order untouched, and nothing is ever re-filtered, so the result count stays
true. Category and store are chosen from lists, and typed brand/colour/size
values snap to the catalogue's own spelling, because the backend matches them
exactly.

**One category list.** `src/lib/categories.js` is the only place categories are
defined (including Maintenance). Search, For you, Profile and the dashboard's
spending categories all import it.

**Compare never invents a price.** Whole-list totals use today's in-stock
shelf prices plus one delivery per store; a store that lacks an item gets no
total. The item-by-item figures are the backend's true cost. See
`docs/BACKEND_INTEGRATION.md` §10 for why the two differ.

**What the backend cannot do is visible, not hidden.** The distance filter is
shown as coming soon. The shopping list says it is saved on this device (it is
kept per account). The registration fields the API will not store are marked
optional under a heading that says so. Every gap is specified in
`docs/BACKEND_INTEGRATION.md` so the backend team can implement it without
guessing.

**Naming.** The app is UniWallet everywhere a student can see. The folder is
still called `mintly-react` because the backend README and backend tests
reference that path; renaming it is a one-line change for the backend team
when they are ready. Old `mintly.*` browser-storage keys are migrated
automatically, so nobody is signed out by the rename.

**The catalogue is not bundled any more.** `docs/seed/products.json` used to be
imported by the app and filtered in the browser. It is now seed data for the
backend's `products` / `product_offers` tables — load it with
`docs/seed/seed_backend.sql`, or `/search` has nothing to return.
