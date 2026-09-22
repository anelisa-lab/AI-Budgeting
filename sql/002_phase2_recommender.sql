-- Additive migration for an existing Day-1 database.
BEGIN;

ALTER TABLE products ADD COLUMN IF NOT EXISTS subcategory VARCHAR(100);
ALTER TABLE product_offers
  ADD COLUMN IF NOT EXISTS rating NUMERIC(2,1),
  ADD COLUMN IF NOT EXISTS rating_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS store_charges (
  id SERIAL PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  charge_type VARCHAR(30) NOT NULL CHECK (charge_type IN
    ('delivery', 'service', 'transaction', 'packaging', 'card', 'collection', 'other')),
  label VARCHAR(120) NOT NULL,
  calculation VARCHAR(20) NOT NULL DEFAULT 'flat' CHECK (calculation IN ('flat', 'percentage')),
  amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  percentage NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (percentage BETWEEN 0 AND 100),
  applies_to VARCHAR(20) NOT NULL DEFAULT 'delivery'
    CHECK (applies_to IN ('delivery', 'collection', 'both')),
  free_over_amount NUMERIC(12,2),
  min_charge NUMERIC(12,2),
  max_charge NUMERIC(12,2),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_subcategory ON products(subcategory);
CREATE INDEX IF NOT EXISTS idx_store_charges_store_active
  ON store_charges(store_id) WHERE is_active = TRUE;
DROP TRIGGER IF EXISTS trg_store_charges_updated_at ON store_charges;
CREATE TRIGGER trg_store_charges_updated_at
BEFORE UPDATE ON store_charges FOR EACH ROW EXECUTE FUNCTION set_updated_at();
COMMIT;