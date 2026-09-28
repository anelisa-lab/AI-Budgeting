-- ============================================================
-- Live store prices — a missing price is NULL, never R0
--
-- Checkers sends price 0 for a product it can't sell right now (out of
-- stock). That used to be saved as a real R0.00 price and shown as "R0,00".
-- From now on:
--   items.price             the store's current price, NULL when it has none
--                           (NULL or > 0 — a 0 can no longer be stored)
--   items.last_known_price  the last real price we saw; a missing price
--                           never overwrites it (app/live_items.py)
--   items.last_priced_at    when last_known_price was seen
--   items.in_stock          unchanged — updated on every refresh
--
-- Existing R0.00 rows are turned into NULL (and marked out of stock, since
-- that is the only way the scraper produced them).
--
-- Needs sql/006_live_items.sql. Safe to run more than once. Also folded into
-- sql/schema.sql, so a brand-new database doesn't need this file.
-- ============================================================

BEGIN;

ALTER TABLE items ALTER COLUMN price DROP NOT NULL;
ALTER TABLE items ADD COLUMN IF NOT EXISTS last_known_price NUMERIC(12,2);
ALTER TABLE items ADD COLUMN IF NOT EXISTS last_priced_at TIMESTAMPTZ;

UPDATE items SET price = NULL, in_stock = FALSE WHERE price <= 0;
UPDATE items SET last_known_price = price, last_priced_at = last_updated
 WHERE price IS NOT NULL AND last_known_price IS NULL;

ALTER TABLE items DROP CONSTRAINT IF EXISTS items_price_check;
ALTER TABLE items DROP CONSTRAINT IF EXISTS chk_items_price_positive;
ALTER TABLE items ADD CONSTRAINT chk_items_price_positive
  CHECK (price IS NULL OR price > 0);
ALTER TABLE items DROP CONSTRAINT IF EXISTS chk_items_last_known_price_positive;
ALTER TABLE items ADD CONSTRAINT chk_items_last_known_price_positive
  CHECK (last_known_price IS NULL OR last_known_price > 0);

COMMIT;
