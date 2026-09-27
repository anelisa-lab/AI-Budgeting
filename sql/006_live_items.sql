-- ============================================================
-- Live store prices — the `items` table
--
-- Products found by the live store search (app/scrapers, currently
-- Checkers Sixty60 only). One row per product per store, keyed on the
-- store's own product code (sku — Checkers' article number), so re-running
-- a search updates the price in place instead of adding a duplicate.
-- last_updated is set to NOW() on every upsert (app/live_items.py).
--
-- Separate from products / product_offers (the curated catalogue that
-- GET /search, Compare and the recommender use) — nothing reads both yet.
--
-- Safe to run on an existing database (IF NOT EXISTS everywhere). Also folded
-- into sql/schema.sql, so a brand-new database doesn't need this file.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS items (
  id            SERIAL PRIMARY KEY,
  store         VARCHAR(50)   NOT NULL,
  sku           VARCHAR(100)  NOT NULL,
  name          TEXT          NOT NULL,
  price         NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  image_url     TEXT,
  product_url   TEXT,
  brand         VARCHAR(150),
  category      VARCHAR(100),
  on_promotion  BOOLEAN       NOT NULL DEFAULT FALSE,
  in_stock      BOOLEAN       NOT NULL DEFAULT TRUE,
  last_updated  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_items_store_sku UNIQUE (store, sku)
);

CREATE INDEX IF NOT EXISTS idx_items_last_updated ON items (last_updated);

COMMIT;
