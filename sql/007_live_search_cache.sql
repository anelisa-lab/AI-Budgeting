-- ============================================================
-- Live store prices — which items each search returned, and when
--
-- GET /api/search (app/routers/live_search.py) answers a query from the
-- database when that store was searched for the same words within the last
-- LIVE_SEARCH_TTL_HOURS (default 6), and only asks the store again after
-- that. live_searches is one row per (store, query); live_search_results
-- keeps the store's own result order, so a cached answer comes back exactly
-- as the store ranked it (matching item names with ILIKE would not — the
-- store's search matches brands, synonyms, etc.).
--
-- Needs sql/006_live_items.sql. Safe to run on an existing database (IF NOT
-- EXISTS everywhere). Also folded into sql/schema.sql.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS live_searches (
  id            SERIAL PRIMARY KEY,
  store         VARCHAR(50)  NOT NULL,     -- key from app/scrapers SCRAPERS, e.g. 'checkers'
  query         VARCHAR(200) NOT NULL,     -- lower-cased, single-spaced
  searched_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  result_count  INTEGER      NOT NULL DEFAULT 0,
  CONSTRAINT uq_live_searches_store_query UNIQUE (store, query)
);

CREATE TABLE IF NOT EXISTS live_search_results (
  search_id  INTEGER NOT NULL REFERENCES live_searches(id) ON DELETE CASCADE,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  rank       INTEGER NOT NULL,
  PRIMARY KEY (search_id, item_id)
);

COMMIT;
