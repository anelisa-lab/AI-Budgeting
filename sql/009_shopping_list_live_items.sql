-- ============================================================
-- Shopping list — live Checkers items can go on it too
--
-- The list (comparison_lists / comparison_items, app/routers/shopping_list.py)
-- held only catalogue offers (product_offers). A line can now point at a
-- live store item instead (items, from GET /api/search) — exactly one of
-- offer_id / item_id per line. Still one line per product per list: adding
-- the same product again raises its qty. price_when_added is the unit price
-- saved at the moment it was added; totals use it, and today's price is only
-- shown next to it ("was R18,99, now R19,99").
--
-- Needs sql/006_live_items.sql and sql/005_phase5_shopping_list.sql.
-- Safe to run more than once. Also folded into sql/schema.sql.
-- Apply without psql:  python -m app.apply_sql sql/009_shopping_list_live_items.sql
-- ============================================================

BEGIN;

-- A line needs its own id now that offer_id can be empty.
ALTER TABLE comparison_items ADD COLUMN IF NOT EXISTS id SERIAL;
DO $$
DECLARE pk TEXT;
BEGIN
  SELECT conname INTO pk FROM pg_constraint
   WHERE conrelid = 'comparison_items'::regclass AND contype = 'p';
  IF pk IS DISTINCT FROM 'comparison_items_line_pkey' THEN
    IF pk IS NOT NULL THEN
      EXECUTE format('ALTER TABLE comparison_items DROP CONSTRAINT %I', pk);
    END IF;
    ALTER TABLE comparison_items ADD CONSTRAINT comparison_items_line_pkey PRIMARY KEY (id);
  END IF;
END $$;

ALTER TABLE comparison_items ALTER COLUMN offer_id DROP NOT NULL;
ALTER TABLE comparison_items
  ADD COLUMN IF NOT EXISTS item_id INTEGER REFERENCES items(id) ON DELETE CASCADE;

-- One line per product per list (NULLs don't collide, so each rule only
-- applies to its own kind of line).
DO $$ BEGIN
  ALTER TABLE comparison_items
    ADD CONSTRAINT uq_comparison_items_offer UNIQUE (comparison_list_id, offer_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE comparison_items
    ADD CONSTRAINT uq_comparison_items_item UNIQUE (comparison_list_id, item_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE comparison_items
    ADD CONSTRAINT chk_comparison_items_one_product CHECK ((offer_id IS NULL) <> (item_id IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
