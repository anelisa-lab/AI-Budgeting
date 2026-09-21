-- ============================================================
-- AI Shopping for Budgeting — Database Schema
-- Owner: Member 2 (Backend Lead)
-- Run this once against a fresh Postgres database:
--   psql -U <user> -d <dbname> -f sql/schema.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(100) NOT NULL,
  email           VARCHAR(150) UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- One row per active budget cycle for a user (e.g. per NSFAS payout period)
CREATE TABLE IF NOT EXISTS budgets (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total_amount      NUMERIC(10,2) NOT NULL,
  remaining_amount  NUMERIC(10,2) NOT NULL,
  cycle_start_date  DATE NOT NULL,
  cycle_end_date    DATE NOT NULL,       -- next payout date; used for Daily Budget Split
  created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Every purchase/spend event against a budget
CREATE TABLE IF NOT EXISTS transactions (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  budget_id    INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  item_name    VARCHAR(150) NOT NULL,
  amount       NUMERIC(10,2) NOT NULL,
  category     VARCHAR(50),
  store        VARCHAR(100),
  created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

-- User shopping preferences, used by the recommender (Member 5/6)
CREATE TABLE IF NOT EXISTS preferences (
  id                    SERIAL PRIMARY KEY,
  user_id               INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  preferred_categories  TEXT[] DEFAULT '{}',
  preferred_stores      TEXT[] DEFAULT '{}',
  max_distance_km       NUMERIC(6,2),
  updated_at            TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_budgets_user_id ON budgets(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_budget_id ON transactions(budget_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
