-- ============================================================
-- Add Boxer as a catalogue-only store, with NO product_offers.
--
-- Boxer's site (boxer.co.za) has no real online product catalogue to scrape
-- (its "Shop Online" link is a dead "#" href, and the rest of the site is
-- CMS marketing pages under /page/<slug>) and no seed data exists for it
-- either, so unlike Pick n Pay / SPAR there are no real prices to attach.
-- The store exists so it can be referenced later if a real price source
-- shows up, but it will not appear in search results until offers are added.
--
--   psql -U <user> -d <dbname> -f sql/010_add_boxer_store.sql
-- Idempotent: safe to run more than once.
-- ============================================================

BEGIN;

INSERT INTO stores (name, store_type, external_store_id)
SELECT 'Boxer', 'physical', 'boxer'
WHERE NOT EXISTS (SELECT 1 FROM stores WHERE external_store_id = 'boxer');

COMMIT;
