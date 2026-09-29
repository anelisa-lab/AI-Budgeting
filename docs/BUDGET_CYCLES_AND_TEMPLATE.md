# Budget cycles, spend dates and the category template

## Apply the migration
    python -m app.apply_sql sql/014_budget_cycles_and_categories.sql
Idempotent. Adds `carried_over_amount`, `completed_at`, `renewed_from_budget_id`,
the `budget_categories` table, and turns a survival threshold of 0 into NULL (off).
New dependency: `openpyxl` (see requirements.txt).

## Behaviour
- **Day count**: days = (payout date - today) + 1. The form preview, dashboard and
  backend all use this (R1715 over 30 days = R55.32/day).
- **Renewal**: `POST /budgets/{id}/renew` completes the old budget and creates the next
  one. total = new allowance + carried leftover; savings = % x new allowance only.
  Savings can be carried too (ledger contribution + matching withdrawal).
  `POST /budgets` also completes an ended active budget instead of returning 409.
- **After payout date** the split reports `cycle_ended` / `days_overdue` and prompts to
  start the next cycle rather than showing the leftover as a daily limit.
- **Spend date**: optional `transaction_date` (not before cycle start, not in the future).
  Past dates are stored at midday in APP_TIMEZONE; back-dated spends skip the daily warning.
- **Edits**: savings recompute when total or percentage changes; survival threshold
  null/0 = off (omitted = unchanged). Write paths lock the budget (`FOR UPDATE`).
- **Transactions**: `PUT /budgets/{id}/transactions/{tid}`; list supports `limit`/`offset`.
- **Categories**: `GET/PUT /budgets/{id}/categories` (max 25, planned total <= spendable).
- **Template**: `POST /budgets/template` returns an .xlsx with the student's categories,
  a Spend log sheet and SUMIFS formulas. Daily columns for periods of 7 days or fewer,
  weekly otherwise. Falls back to the active budget for the amount and period.

## Verification status
Unit tests, contract tests (88) and real-Postgres SQL checks pass; the template was
recalculated in LibreOffice with 0 formula errors. Not exercised: the FastAPI routes over
HTTP, a real `vite build`, and the screens in a browser.
