-- ============================================================
-- store_charges seed — Member 6, rewritten in Phase 4
--
--   psql -U <user> -d <dbname> -f sql/seed_store_charges.sql
--
-- Run AFTER the catalogue seed (it matches stores on external_store_id) and
-- after sql/003_phase4_prices_and_fulfilment.sql. Re-running replaces its own
-- rows; it never touches rows the team added by hand.
--
-- WHAT CHANGED IN PHASE 4, AND WHY
-- The Phase 2 version inserted three fees that had no source at all:
--   * a R3.50 "card payment surcharge" on every physical store — added to
--     every in-store price on Search, For you and Compare;
--   * a R2.00 "shopping bag" levy on every collection;
--   * a 2.5% "online handling fee" on online stores.
-- None of them came from a retailer. They were placeholders that the app
-- then presented as part of the "true cost". They are gone.
--
-- What remains is each store's own delivery fee and free-delivery threshold,
-- from Member 9's store table (docs/seed/stores.csv). Those are also
-- ESTIMATES until someone confirms them on the retailer's site — the note
-- column says so. Shoprite Warwick has no row because it doesn't deliver
-- (stores.delivery_available = FALSE).
--
-- store_true_cost() skips a delivery row when the offer carries its own
-- shipping_cost (never charge delivery twice), so single-item true cost is
-- unchanged. The basket comparison (/compare/basket) uses these rows to
-- charge delivery ONCE per order and to test the free-delivery threshold
-- against the whole basket.
-- ============================================================

BEGIN;

DELETE FROM store_charges WHERE note IN ('demo seed', 'store delivery (seed estimate)');

INSERT INTO store_charges
  (store_id, charge_type, label, calculation, amount, applies_to, free_over_amount, is_active, note)
SELECT s.id, 'delivery', 'Delivery', 'flat', v.fee, 'delivery', v.free_over, TRUE,
       'store delivery (seed estimate)'
FROM stores s
JOIN (VALUES
    ('checkers', 35.00::NUMERIC, NULL::NUMERIC),
    ('game', 60.00, 1000.00),
    ('picknpay', 45.00, NULL),
    ('clicks', 50.00, 450.00),
    ('spar', 40.00, NULL),
    ('foodlovers', 45.00, NULL),
    ('makro', 65.00, 1000.00),
    ('incredible', 99.00, 2000.00),
    ('takealot', 60.00, 450.00)
) AS v(slug, fee, free_over) ON v.slug = s.external_store_id;

COMMIT;

-- Check:
--   SELECT s.name, c.amount, c.free_over_amount FROM store_charges c
--   JOIN stores s ON s.id = c.store_id ORDER BY s.name;
