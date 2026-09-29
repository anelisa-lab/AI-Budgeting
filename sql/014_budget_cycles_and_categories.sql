-- ============================================================
-- Budget cycles and priority categories
--
-- * budgets.carried_over_amount   money rolled in from the previous cycle
--                                 (savings are a % of the FRESH allowance only)
-- * budgets.completed_at          when a cycle was closed (POST /budgets/{id}/renew
--                                 or a new budget replacing one that had ended)
-- * budgets.renewed_from_budget_id  links a cycle to the one before it
-- * budget_categories             the student's priority categories for a
--                                 budget, each with an optional planned amount.
--                                 Also what the downloadable spreadsheet
--                                 template (POST /budgets/template) is built from.
-- * survival_threshold = 0        was a live threshold that flipped an empty
--                                 budget into "survival mode"; 0 now means off,
--                                 stored as NULL.
--
--   psql -U <user> -d <dbname> -f sql/014_budget_cycles_and_categories.sql
--   python -m app.apply_sql sql/014_budget_cycles_and_categories.sql
-- Idempotent.
-- ============================================================

BEGIN;

ALTER TABLE budgets
  ADD COLUMN IF NOT EXISTS carried_over_amount NUMERIC(12,2) NOT NULL DEFAULT 0
      CHECK (carried_over_amount >= 0);

ALTER TABLE budgets
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

ALTER TABLE budgets
  ADD COLUMN IF NOT EXISTS renewed_from_budget_id INTEGER
      REFERENCES budgets(id) ON DELETE SET NULL;

UPDATE budgets SET survival_threshold = NULL WHERE survival_threshold = 0;

CREATE TABLE IF NOT EXISTS budget_categories (
  id              SERIAL PRIMARY KEY,
  budget_id       INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  name            VARCHAR(60) NOT NULL,
  planned_amount  NUMERIC(12,2) CHECK (planned_amount IS NULL OR planned_amount >= 0),
  position        INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per name per budget, whatever the case ("Groceries" == "groceries").
CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_categories_name
  ON budget_categories (budget_id, LOWER(name));

CREATE INDEX IF NOT EXISTS idx_budget_categories_budget
  ON budget_categories (budget_id, position);

COMMIT;
