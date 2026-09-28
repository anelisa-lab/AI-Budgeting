-- ============================================================
-- Add Woolworths as a catalogue-only store, with NO product_offers.
--
-- Woolworths' robots.txt (woolworths.co.za/robots.txt) disallows its
-- internal search path (`Disallow: /*searchterm` under the general
-- `User-agent: *` block) — the same reason Pick n Pay has no live scraper.
-- It separately lists several AI/LLM crawlers (ClaudeBot included) with a
-- bare "Allow: /", which reads as permission to index its content for
-- answering questions, not an invitation to build an automated shopping
-- search feature against the path the general rule disallows — so this
-- still counts as "search is disallowed" under the same policy applied to
-- every other store here.
--
-- No seed data exists for Woolworths either, so there are no real prices to
-- attach yet. The store exists so it can be referenced once a real price
-- source shows up; until then it will not appear in search results.
--
--   psql -U <user> -d <dbname> -f sql/011_add_woolworths_store.sql
-- Idempotent: safe to run more than once.
-- ============================================================

BEGIN;

INSERT INTO stores (name, store_type, external_store_id)
SELECT 'Woolworths', 'physical', 'woolworths'
WHERE NOT EXISTS (SELECT 1 FROM stores WHERE external_store_id = 'woolworths');

COMMIT;
