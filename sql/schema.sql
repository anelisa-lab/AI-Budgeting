-- ============================================================
-- AI Shopping for Budgeting — Database Schema
-- Owner: Member 2 (Backend Lead)
-- Run this once against a fresh Postgres database:
--   psql -U <user> -d <dbname> -f sql/schema.sql
-- ============================================================

BEGIN;

-- -------------------------
-- Common helper
-- -------------------------

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- -------------------------
-- Accounts and user context
-- -------------------------

CREATE TABLE IF NOT EXISTS users (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(100) NOT NULL,
  email               VARCHAR(150) NOT NULL,
  password_hash       TEXT NOT NULL,
  phone_number        VARCHAR(30),
  residence_area_code VARCHAR(100),
  student_number      VARCHAR(9),
  email_verified_at   TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_users_student_number_format
    CHECK (student_number IS NULL OR student_number ~ '^[0-9]{8,9}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower
  ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS user_sessions (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A user may save more than one location, but only one can be the
-- default location used for nearby-store and distance filtering.
CREATE TABLE IF NOT EXISTS user_locations (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label             VARCHAR(100) NOT NULL DEFAULT 'Default',
  latitude          NUMERIC(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude         NUMERIC(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  is_default        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_default_location
  ON user_locations (user_id)
  WHERE is_default = TRUE;

CREATE TABLE IF NOT EXISTS preferences (
  id                    SERIAL PRIMARY KEY,
  user_id               INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  preferred_categories  TEXT[] NOT NULL DEFAULT '{}',
  preferred_stores      TEXT[] NOT NULL DEFAULT '{}',
  preferred_brands      TEXT[] NOT NULL DEFAULT '{}',
  preferred_colours     TEXT[] NOT NULL DEFAULT '{}',
  preferred_sizes       TEXT[] NOT NULL DEFAULT '{}',
  max_distance_km       NUMERIC(6,2) CHECK (max_distance_km IS NULL OR max_distance_km >= 0),
  max_product_price     NUMERIC(12,2) CHECK (max_product_price IS NULL OR max_product_price >= 0),
  max_shipping_cost     NUMERIC(12,2) CHECK (max_shipping_cost IS NULL OR max_shipping_cost >= 0),
  require_available     BOOLEAN NOT NULL DEFAULT TRUE,
  essential_only        BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -------------------------
-- Allowance, savings and budget protection
-- -------------------------

CREATE TABLE IF NOT EXISTS budgets (
  id                    SERIAL PRIMARY KEY,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  budget_kind           VARCHAR(20) NOT NULL DEFAULT 'monthly'
                        CHECK (budget_kind IN ('monthly', 'available')),
  status                VARCHAR(20) NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'completed', 'cancelled')),
  currency              CHAR(3) NOT NULL DEFAULT 'ZAR',
  total_amount         NUMERIC(12,2) NOT NULL CHECK (total_amount > 0),
  remaining_amount     NUMERIC(12,2) NOT NULL CHECK (remaining_amount >= 0),
  savings_percentage   NUMERIC(5,2) NOT NULL DEFAULT 0
                        CHECK (savings_percentage BETWEEN 0 AND 100),
  savings_amount       NUMERIC(12,2) NOT NULL DEFAULT 0
                        CHECK (savings_amount >= 0),
  daily_limit          NUMERIC(12,2) CHECK (daily_limit IS NULL OR daily_limit >= 0),
  survival_threshold   NUMERIC(12,2) CHECK (survival_threshold IS NULL OR survival_threshold >= 0),
  budget_mode          VARCHAR(20) NOT NULL DEFAULT 'normal'
                        CHECK (budget_mode IN ('normal', 'survival')),
  cycle_start_date    DATE NOT NULL,
  cycle_end_date      DATE NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT budgets_valid_cycle CHECK (cycle_end_date >= cycle_start_date),
  CONSTRAINT budgets_savings_within_total CHECK (savings_amount <= total_amount),
  CONSTRAINT budgets_remaining_within_total CHECK (remaining_amount <= total_amount)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_budget_per_user
  ON budgets (user_id)
  WHERE status = 'active';

-- Stores both smart-savings contributions and withdrawals/adjustments.
CREATE TABLE IF NOT EXISTS savings_ledger (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  budget_id      INTEGER REFERENCES budgets(id) ON DELETE SET NULL,
  entry_type     VARCHAR(20) NOT NULL
                 CHECK (entry_type IN ('contribution', 'withdrawal', 'adjustment')),
  amount         NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per budget day makes the Daily Budget Split observable and
-- allows recalculation after a transaction is recorded.
CREATE TABLE IF NOT EXISTS budget_daily_limits (
  id                    SERIAL PRIMARY KEY,
  budget_id             INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  limit_date            DATE NOT NULL,
  planned_limit         NUMERIC(12,2) NOT NULL CHECK (planned_limit >= 0),
  spent_amount          NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (spent_amount >= 0),
  remaining_limit       NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (remaining_limit >= 0),
  recalculated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (budget_id, limit_date)
);

-- -------------------------
-- Retailers, stores and products
-- -------------------------

CREATE TABLE IF NOT EXISTS retailer_sources (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(150) NOT NULL,
  source_type     VARCHAR(20) NOT NULL
                  CHECK (source_type IN ('online', 'physical', 'mixed', 'api')),
  base_url        TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  last_synced_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stores (
  id                SERIAL PRIMARY KEY,
  retailer_source_id INTEGER REFERENCES retailer_sources(id) ON DELETE SET NULL,
  name              VARCHAR(150) NOT NULL,
  store_type        VARCHAR(20) NOT NULL DEFAULT 'online'
                    CHECK (store_type IN ('online', 'physical', 'mixed')),
  address           TEXT,
  latitude          NUMERIC(9,6) CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude         NUMERIC(9,6) CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  external_store_id VARCHAR(150),
  -- Phase 4: NULL = not recorded (falls back to store_type). See 003.
  delivery_available   BOOLEAN,
  collection_available BOOLEAN,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id                 SERIAL PRIMARY KEY,
  name               VARCHAR(250) NOT NULL,
  description        TEXT,
  brand              VARCHAR(150),
  category           VARCHAR(100),
  subcategory        VARCHAR(100),
  colour             VARCHAR(80),
  size               VARCHAR(80),
  is_essential       BOOLEAN NOT NULL DEFAULT FALSE,
  attributes         JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- An offer is a product as listed by a particular retailer/store.
-- Keeping offers separate supports price comparison and source freshness.
CREATE TABLE IF NOT EXISTS product_offers (
  id                   SERIAL PRIMARY KEY,
  product_id           INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id             INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  external_product_id  VARCHAR(200),
  product_url          TEXT,
  price                NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  shipping_cost        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (shipping_cost >= 0),
  total_cost           NUMERIC(12,2)
                       GENERATED ALWAYS AS (price + shipping_cost) STORED,
  currency             CHAR(3) NOT NULL DEFAULT 'ZAR',
  availability_status  VARCHAR(20) NOT NULL DEFAULT 'unknown'
                       CHECK (availability_status IN ('available', 'out_of_stock', 'unknown')),
  rating               NUMERIC(2,1)
                       CONSTRAINT product_offers_rating_range
                       CHECK (rating IS NULL OR rating BETWEEN 0 AND 5),
  rating_count         INTEGER NOT NULL DEFAULT 0
                       CONSTRAINT product_offers_rating_count_positive
                       CHECK (rating_count >= 0),
  stock_quantity       INTEGER CHECK (stock_quantity IS NULL OR stock_quantity >= 0),
  estimated_delivery_days INTEGER
                       CHECK (estimated_delivery_days IS NULL OR estimated_delivery_days >= 0),
  last_checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Phase 4: where the price came from. Only a real source sets
  -- price_verified_at; a seed_estimate has never been checked.
  price_source         VARCHAR(20) NOT NULL DEFAULT 'seed_estimate'
                       CONSTRAINT product_offers_price_source_check
                       CHECK (price_source IN ('seed_estimate', 'live_api', 'verified_manual')),
  price_source_detail  TEXT,
  price_verified_at    TIMESTAMPTZ,
  valid_until          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (store_id, external_product_id)
);

-- Phase 4: every price a live refresh applied, and what it matched.
CREATE TABLE IF NOT EXISTS offer_price_history (
  id            SERIAL PRIMARY KEY,
  offer_id      INTEGER NOT NULL REFERENCES product_offers(id) ON DELETE CASCADE,
  price         NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  price_source  VARCHAR(20) NOT NULL,
  source_detail TEXT,
  source_title  TEXT,
  observed_at   TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_offer_price_history_offer
  ON offer_price_history(offer_id, observed_at DESC);

-- Per-store charges that are NOT part of the listed price: delivery fees,
-- service/handling fees, card surcharges, packaging levies. Member 6's
-- store_true_cost() reads these so "true cost" is the number a student
-- actually pays, not the sticker price.
--
-- Rules of the table:
--   * calculation='flat'       -> add `amount`
--   * calculation='percentage' -> add `percentage` % of the item subtotal,
--                                 then clamp to [min_charge, max_charge]
--   * free_over_amount         -> the charge falls away once the subtotal
--                                 reaches this value (free delivery over R500)
--   * applies_to               -> 'delivery' | 'collection' | 'both', so a
--                                 student collecting in person isn't charged
--                                 a courier fee
--   * a charge_type='delivery' row is IGNORED when the offer already carries
--     its own product_offers.shipping_cost — the offer-level number is more
--     specific and would otherwise be double-counted.
CREATE TABLE IF NOT EXISTS store_charges (
  id                SERIAL PRIMARY KEY,
  store_id          INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  charge_type       VARCHAR(30) NOT NULL
                    CHECK (charge_type IN ('delivery', 'service', 'transaction',
                                           'packaging', 'card', 'collection', 'other')),
  label             VARCHAR(120) NOT NULL,
  calculation       VARCHAR(20) NOT NULL DEFAULT 'flat'
                    CHECK (calculation IN ('flat', 'percentage')),
  amount            NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  percentage        NUMERIC(5,2) NOT NULL DEFAULT 0
                    CHECK (percentage BETWEEN 0 AND 100),
  applies_to        VARCHAR(20) NOT NULL DEFAULT 'delivery'
                    CHECK (applies_to IN ('delivery', 'collection', 'both')),
  free_over_amount  NUMERIC(12,2) CHECK (free_over_amount IS NULL OR free_over_amount >= 0),
  min_charge        NUMERIC(12,2) CHECK (min_charge IS NULL OR min_charge >= 0),
  max_charge        NUMERIC(12,2) CHECK (max_charge IS NULL OR max_charge >= 0),
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT store_charges_min_max CHECK (
    min_charge IS NULL OR max_charge IS NULL OR max_charge >= min_charge
  )
);

-- -------------------------
-- Search, comparison and recommendations
-- -------------------------

CREATE TABLE IF NOT EXISTS shopping_searches (
  id                    SERIAL PRIMARY KEY,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  budget_id             INTEGER REFERENCES budgets(id) ON DELETE SET NULL,
  query_text            TEXT NOT NULL,
  budget_limit          NUMERIC(12,2) CHECK (budget_limit IS NULL OR budget_limit >= 0),
  parsed_constraints    JSONB NOT NULL DEFAULT '{}'::JSONB,
  status                VARCHAR(20) NOT NULL DEFAULT 'completed'
                        CHECK (status IN ('pending', 'completed', 'failed')),
  response_time_ms      INTEGER CHECK (response_time_ms IS NULL OR response_time_ms >= 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recommendation_runs (
  id                    SERIAL PRIMARY KEY,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  budget_id             INTEGER REFERENCES budgets(id) ON DELETE SET NULL,
  search_id             INTEGER REFERENCES shopping_searches(id) ON DELETE SET NULL,
  model_name            VARCHAR(150),
  response_time_ms      INTEGER CHECK (response_time_ms IS NULL OR response_time_ms >= 0),
  source_count          INTEGER CHECK (source_count IS NULL OR source_count >= 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recommendation_items (
  id                    SERIAL PRIMARY KEY,
  recommendation_run_id INTEGER NOT NULL REFERENCES recommendation_runs(id) ON DELETE CASCADE,
  offer_id              INTEGER NOT NULL REFERENCES product_offers(id) ON DELETE CASCADE,
  rank                  INTEGER NOT NULL CHECK (rank > 0),
  score                 NUMERIC(8,5),
  total_cost_snapshot   NUMERIC(12,2) NOT NULL CHECK (total_cost_snapshot >= 0),
  meets_budget          BOOLEAN NOT NULL DEFAULT FALSE,
  meets_preferences     BOOLEAN NOT NULL DEFAULT FALSE,
  explanation           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (recommendation_run_id, offer_id)
);

CREATE TABLE IF NOT EXISTS comparison_lists (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  search_id   INTEGER REFERENCES shopping_searches(id) ON DELETE SET NULL,
  name        VARCHAR(150) NOT NULL DEFAULT 'My comparison',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase 5: the student's shopping list (one list per student, see
-- app/routers/shopping_list.py). qty and price_when_added come from
-- sql/005_phase5_shopping_list.sql.
CREATE TABLE IF NOT EXISTS comparison_items (
  comparison_list_id INTEGER NOT NULL REFERENCES comparison_lists(id) ON DELETE CASCADE,
  offer_id           INTEGER NOT NULL REFERENCES product_offers(id) ON DELETE CASCADE,
  qty                INTEGER NOT NULL DEFAULT 1
                     CONSTRAINT chk_comparison_items_qty CHECK (qty BETWEEN 1 AND 99),
  price_when_added   NUMERIC(12,2) CHECK (price_when_added IS NULL OR price_when_added >= 0),
  added_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (comparison_list_id, offer_id)
);

CREATE INDEX IF NOT EXISTS idx_comparison_lists_user_id ON comparison_lists (user_id);

CREATE TABLE IF NOT EXISTS saved_offers (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  offer_id    INTEGER NOT NULL REFERENCES product_offers(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, offer_id)
);

-- -------------------------
-- Spend logging and budget protection
-- -------------------------

CREATE TABLE IF NOT EXISTS transactions (
  id                   SERIAL PRIMARY KEY,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  budget_id            INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  product_id           INTEGER REFERENCES products(id) ON DELETE SET NULL,
  offer_id             INTEGER REFERENCES product_offers(id) ON DELETE SET NULL,
  store_id             INTEGER REFERENCES stores(id) ON DELETE SET NULL,
  item_name            VARCHAR(150) NOT NULL,
  quantity             INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  amount               NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  subtotal             NUMERIC(12,2) CHECK (subtotal IS NULL OR subtotal >= 0),
  shipping_amount      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (shipping_amount >= 0),
  category             VARCHAR(100),
  category_source      VARCHAR(20) NOT NULL DEFAULT 'user'
                       CHECK (category_source IN ('user', 'rule', 'ai')),
  is_essential         BOOLEAN NOT NULL DEFAULT FALSE,
  transaction_status   VARCHAR(20) NOT NULL DEFAULT 'completed'
                       CHECK (transaction_status IN ('planned', 'completed', 'voided')),
  transaction_date     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cooling-off applies to a planned non-essential purchase, not to a
-- completed payment. The system is explicitly out of scope for payments.
CREATE TABLE IF NOT EXISTS cooling_off_periods (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  budget_id         INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  transaction_id    INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  offer_id          INTEGER REFERENCES product_offers(id) ON DELETE SET NULL,
  amount            NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reason            TEXT,
  expires_at        TIMESTAMPTZ NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'waiting'
                    CHECK (status IN ('waiting', 'approved', 'dismissed', 'expired')),
  decided_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -------------------------
-- Low-data alerts
-- -------------------------

CREATE TABLE IF NOT EXISTS alert_preferences (
  id                    SERIAL PRIMARY KEY,
  user_id               INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sms_enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  ussd_enabled          BOOLEAN NOT NULL DEFAULT FALSE,
  low_balance_threshold NUMERIC(12,2) CHECK (low_balance_threshold IS NULL OR low_balance_threshold >= 0),
  daily_limit_alerts    BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS budget_alerts (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  budget_id      INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  channel        VARCHAR(20) NOT NULL CHECK (channel IN ('in_app', 'sms', 'ussd')),
  alert_type     VARCHAR(30) NOT NULL
                 CHECK (alert_type IN ('low_balance', 'daily_limit', 'budget_exceeded', 'savings')),
  message        TEXT NOT NULL,
  delivery_status VARCHAR(20) NOT NULL DEFAULT 'pending'
                 CHECK (delivery_status IN ('pending', 'sent', 'failed')),
  sent_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -------------------------
-- Community features
-- -------------------------

CREATE TABLE IF NOT EXISTS bulk_buy_groups (
  id                SERIAL PRIMARY KEY,
  creator_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id        INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  offer_id          INTEGER REFERENCES product_offers(id) ON DELETE SET NULL,
  target_quantity   INTEGER NOT NULL CHECK (target_quantity > 0),
  current_quantity  INTEGER NOT NULL DEFAULT 0 CHECK (current_quantity >= 0),
  location_latitude NUMERIC(9,6) CHECK (location_latitude IS NULL OR location_latitude BETWEEN -90 AND 90),
  location_longitude NUMERIC(9,6) CHECK (location_longitude IS NULL OR location_longitude BETWEEN -180 AND 180),
  closes_at         TIMESTAMPTZ,
  status            VARCHAR(20) NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'matched', 'closed', 'cancelled')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bulk_buy_members (
  group_id       INTEGER NOT NULL REFERENCES bulk_buy_groups(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  member_status  VARCHAR(20) NOT NULL DEFAULT 'joined'
                 CHECK (member_status IN ('joined', 'cancelled', 'fulfilled')),
  joined_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);

-- This is an aggregate, not a raw transaction-sharing table. The service
-- should publish only groups that meet its privacy threshold (for example,
-- participant_count >= 5) so individual student spending is not exposed.
CREATE TABLE IF NOT EXISTS residence_spend_summaries (
  id                SERIAL PRIMARY KEY,
  residence_area_code VARCHAR(100) NOT NULL,
  period_start      DATE NOT NULL,
  period_end        DATE NOT NULL,
  participant_count INTEGER NOT NULL CHECK (participant_count >= 0),
  transaction_count INTEGER NOT NULL CHECK (transaction_count >= 0),
  total_spend       NUMERIC(14,2) NOT NULL CHECK (total_spend >= 0),
  average_spend     NUMERIC(14,2) NOT NULL CHECK (average_spend >= 0),
  generated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (residence_area_code, period_start, period_end),
  CONSTRAINT valid_summary_period CHECK (period_end >= period_start)
);

-- -------------------------
-- Indexes
-- -------------------------

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id
  ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_locations_user_id
  ON user_locations(user_id);
CREATE INDEX IF NOT EXISTS idx_budgets_user_id
  ON budgets(user_id);
CREATE INDEX IF NOT EXISTS idx_budgets_cycle_dates
  ON budgets(cycle_start_date, cycle_end_date);
CREATE INDEX IF NOT EXISTS idx_savings_ledger_budget_id
  ON savings_ledger(budget_id);
CREATE INDEX IF NOT EXISTS idx_daily_limits_budget_date
  ON budget_daily_limits(budget_id, limit_date);
CREATE INDEX IF NOT EXISTS idx_stores_location
  ON stores(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_products_category
  ON products(category);
CREATE INDEX IF NOT EXISTS idx_product_offers_product_id
  ON product_offers(product_id);
CREATE INDEX IF NOT EXISTS idx_product_offers_store_id
  ON product_offers(store_id);
CREATE INDEX IF NOT EXISTS idx_product_offers_availability
  ON product_offers(availability_status);
CREATE INDEX IF NOT EXISTS idx_product_offers_total_cost
  ON product_offers(total_cost);
CREATE INDEX IF NOT EXISTS idx_products_subcategory
  ON products(subcategory);
CREATE INDEX IF NOT EXISTS idx_store_charges_store_active
  ON store_charges(store_id) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_searches_user_created
  ON shopping_searches(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recommendation_runs_user_created
  ON recommendation_runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_budget_date
  ON transactions(budget_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_user_date
  ON transactions(user_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_cooling_off_status_expiry
  ON cooling_off_periods(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_alerts_user_created
  ON budget_alerts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bulk_buy_product_status
  ON bulk_buy_groups(product_id, status);
CREATE INDEX IF NOT EXISTS idx_residence_summary_period
  ON residence_spend_summaries(residence_area_code, period_start, period_end);

-- -------------------------
-- Automatic updated_at values
-- -------------------------

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_locations_updated_at ON user_locations;
CREATE TRIGGER trg_locations_updated_at
BEFORE UPDATE ON user_locations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_preferences_updated_at ON preferences;
CREATE TRIGGER trg_preferences_updated_at
BEFORE UPDATE ON preferences
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_budgets_updated_at ON budgets;
CREATE TRIGGER trg_budgets_updated_at
BEFORE UPDATE ON budgets
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_sources_updated_at ON retailer_sources;
CREATE TRIGGER trg_sources_updated_at
BEFORE UPDATE ON retailer_sources
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_stores_updated_at ON stores;
CREATE TRIGGER trg_stores_updated_at
BEFORE UPDATE ON stores
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_products_updated_at ON products;
CREATE TRIGGER trg_products_updated_at
BEFORE UPDATE ON products
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_offers_updated_at ON product_offers;
CREATE TRIGGER trg_offers_updated_at
BEFORE UPDATE ON product_offers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_store_charges_updated_at ON store_charges;
CREATE TRIGGER trg_store_charges_updated_at
BEFORE UPDATE ON store_charges
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_comparison_lists_updated_at ON comparison_lists;
CREATE TRIGGER trg_comparison_lists_updated_at
BEFORE UPDATE ON comparison_lists
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_alert_preferences_updated_at ON alert_preferences;
CREATE TRIGGER trg_alert_preferences_updated_at
BEFORE UPDATE ON alert_preferences
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
