-- ============================================================
-- Phase 5 — the shopping list moves to the server
--
-- comparison_lists / comparison_items have been in the schema since Phase 1
-- but nothing used them, so the list lived in each browser's localStorage and
-- did not follow a student to another device. GET/POST/PUT/DELETE
-- /shopping-list (app/routers/shopping_list.py) now use them, one list per
-- student. A list line needs a quantity, and the price it was added at (so
-- Compare can say "was R9,00" when today's price differs).
--
-- Safe to run on an existing database (IF NOT EXISTS everywhere). Also folded
-- into sql/schema.sql, so a brand-new database doesn't need this file.
-- ============================================================

BEGIN;

ALTER TABLE comparison_items
  ADD COLUMN IF NOT EXISTS qty INTEGER NOT NULL DEFAULT 1;
ALTER TABLE comparison_items
  DROP CONSTRAINT IF EXISTS chk_comparison_items_qty;
ALTER TABLE comparison_items
  ADD CONSTRAINT chk_comparison_items_qty CHECK (qty BETWEEN 1 AND 99);

ALTER TABLE comparison_items
  ADD COLUMN IF NOT EXISTS price_when_added NUMERIC(12,2)
  CHECK (price_when_added IS NULL OR price_when_added >= 0);

CREATE INDEX IF NOT EXISTS idx_comparison_lists_user_id ON comparison_lists (user_id);

COMMIT;
