-- ============================================================
-- Phase 4 migration — price provenance, live prices, how stores serve students
--
--   psql -U <user> -d <dbname> -f sql/003_phase4_prices_and_fulfilment.sql
--
-- Idempotent: safe to run more than once. A FRESH database gets all of this
-- from sql/schema.sql and does not need this file.
--
-- Run order on an existing database:
--   003 (this file) -> mintly-react/docs/seed/seed_backend.sql -> sql/seed_store_charges.sql
-- ============================================================

BEGIN;

-- ---- 1. Can the store actually deliver / be collected from? -------------
-- Phase 3 had no way to say "Shoprite Warwick doesn't deliver", so it was
-- shown as FREE delivery, and "collect from Takealot" was priced as if you
-- could walk in. NULL means "not recorded" and falls back to the store type
-- (see app/true_cost.py Offer.can_deliver / can_collect).
ALTER TABLE stores ADD COLUMN IF NOT EXISTS delivery_available   BOOLEAN;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS collection_available BOOLEAN;

-- Member 9's store facts (docs/seed/stores.csv), matched on the slug.
UPDATE stores s
   SET delivery_available = v.delivers, collection_available = v.collects
  FROM (VALUES
    ('shoprite',   FALSE, TRUE),
    ('checkers',   TRUE,  TRUE),
    ('game',       TRUE,  TRUE),
    ('picknpay',   TRUE,  TRUE),
    ('clicks',     TRUE,  TRUE),
    ('spar',       TRUE,  TRUE),
    ('foodlovers', TRUE,  TRUE),
    ('makro',      TRUE,  TRUE),
    ('incredible', TRUE,  TRUE),
    ('takealot',   TRUE,  FALSE)
  ) AS v(slug, delivers, collects)
 WHERE s.external_store_id = v.slug;

UPDATE stores SET collection_available = FALSE
 WHERE store_type = 'online' AND collection_available IS NULL;

-- ---- 2. Where did this price come from? ---------------------------------
-- Every Phase 3 price was MODELLED by docs/seed/build_seed.py, and the seed
-- stamped last_checked_at = NOW() on each one, so the app called invented
-- numbers freshly checked. price_verified_at is only ever set by a real
-- source (python -m app.price_feed refresh).
ALTER TABLE product_offers
  ADD COLUMN IF NOT EXISTS price_source VARCHAR(20) NOT NULL DEFAULT 'seed_estimate';
ALTER TABLE product_offers ADD COLUMN IF NOT EXISTS price_source_detail TEXT;
ALTER TABLE product_offers ADD COLUMN IF NOT EXISTS price_verified_at   TIMESTAMPTZ;

DO $$
BEGIN
  ALTER TABLE product_offers ADD CONSTRAINT product_offers_price_source_check
    CHECK (price_source IN ('seed_estimate', 'live_api', 'verified_manual'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---- 3. Price history from live refreshes -------------------------------
CREATE TABLE IF NOT EXISTS offer_price_history (
  id            SERIAL PRIMARY KEY,
  offer_id      INTEGER NOT NULL REFERENCES product_offers(id) ON DELETE CASCADE,
  price         NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  price_source  VARCHAR(20) NOT NULL,
  source_detail TEXT,
  source_title  TEXT,             -- the retailer's own product title it matched
  observed_at   TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_offer_price_history_offer
  ON offer_price_history(offer_id, observed_at DESC);

COMMIT;

-- Check:
--   SELECT price_source, count(*) FROM product_offers GROUP BY 1;
--   SELECT name, delivery_available, collection_available FROM stores ORDER BY name;
