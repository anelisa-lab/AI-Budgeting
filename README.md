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

## Schema (for sign-off — see `sql/schema.sql`)

- **users**: id, name, email, password_hash, created_at
- **budgets**: id, user_id, total_amount, remaining_amount, cycle_start_date, cycle_end_date, created_at, updated_at
- **transactions**: id, user_id, budget_id, item_name, amount, category, store, created_at
- **preferences**: id, user_id, preferred_categories[], preferred_stores[], max_distance_km, updated_at

`cycle_end_date` on `budgets` is the next NSFAS payout date — Member 6 needs
this for the Daily Budget Split calc (`remaining_amount ÷ days until cycle_end_date`).

## For Member 3 (budgets)

Query `budgets` filtered by `user_id` (available via the `get_current_user_id`
dependency, already wired — see `app/dependencies.py`). Insert into
`transactions`, then update `budgets.remaining_amount` in the same request.

## For Member 4/5/6 (search, recommender, true cost)

`preferences` is already seeded with an empty row on every registration —
you'll never hit a missing-row case. Join against it using `user_id`. Since
this is now Python, Member 5/6 can use `pandas`/`numpy` directly in their
router files if the recommender logic gets more advanced than simple
rule-based scoring — just add them to `requirements.txt`.

## Project structure

```
app/
  main.py           # FastAPI app, mounts all routers
  database.py        # Postgres connection helper
  security.py         # password hashing + JWT helpers
  dependencies.py    # get_current_user_id — use as a route dependency
  schemas.py           # Pydantic request/response models
  routers/
    auth.py
    profile.py
sql/
  schema.sql
```

## License

This project was built for academic purposes as part of coursework at DUT.
