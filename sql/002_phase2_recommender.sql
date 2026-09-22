-- ============================================================
-- Migration 002 — Phase 2 recommender / true-cost support
-- Owner: Member 6 (with Member 5)
--
-- sql/schema.sql already contains everything in here, so a FRESH database
-- needs nothing extra. Run this only if you created your database from the
-- Day-1 version of schema.sql and don't want to drop it:
--
--   psql -U <user> -d <dbname> -f sql/002_phase2_recommender.sql
--
-- Every statement is additive and idempotent — running it twice is safe.
-- ============================================================

BEGIN;

-- 1. products.subcategory — the recommender scores "toiletries > soap" style
--    matches, and Member 4's search now returns it.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS subcategory VARCHAR(100);

-- 2. offer rating — one of the recommender's scoring components.
ALTER TABLE product_offers
  ADD COLUMN IF NOT EXISTS rating NUMERIC(2,1),
  ADD COLUMN IF NOT EXISTS rating_count INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_offers_rating_range'
  ) THEN
    ALTER TABLE product_offers
      ADD CONSTRAINT product_offers_rating_range
      CHECK (rating IS NULL OR rating BETWEEN 0 AND 5);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_offers_rating_count_positive'
  ) THEN
    ALTER TABLE product_offers
      ADD CONSTRAINT product_offers_rating_count_positive
      CHECK (rating_count >= 0);
  END IF;
END;
$$;

-- 3. store_charges — the fees store_true_cost() adds on top of price+shipping.
--    See the comment block above this table in sql/schema.sql for the rules.
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

CREATE INDEX IF NOT EXISTS idx_products_subcategory
  ON products(subcategory);
CREATE INDEX IF NOT EXISTS idx_store_charges_store_active
  ON store_charges(store_id) WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS trg_store_charges_updated_at ON store_charges;
CREATE TRIGGER trg_store_charges_updated_at
BEFORE UPDATE ON store_charges
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
