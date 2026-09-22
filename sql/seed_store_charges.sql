-- ============================================================
-- Sample store_charges rows — Member 6
--
-- Member 9 owns the product/store seed data; this file only fills the new
-- store_charges table so /true-cost and /recommendations have something to
-- add up during the demo. It matches stores by name, so it is safe to run
-- after Member 9's seed regardless of the ids that got assigned.
--
--   psql -U <user> -d <dbname> -f sql/seed_store_charges.sql
--
-- Re-running it replaces the demo rows rather than duplicating them.
-- Figures are realistic placeholders for a Durban student — swap them for
-- whatever the real seed stores charge.
-- ============================================================

BEGIN;

DELETE FROM store_charges WHERE note = 'demo seed';

-- Online retailers: courier fee that falls away on bigger baskets.
INSERT INTO store_charges
  (store_id, charge_type, label, calculation, amount, applies_to, free_over_amount, is_active, note)
SELECT id, 'delivery', 'Standard courier delivery', 'flat', 60.00, 'delivery', 500.00, TRUE, 'demo seed'
FROM stores
WHERE store_type IN ('online', 'mixed');

-- Online retailers: percentage handling fee, capped so it can't run away.
INSERT INTO store_charges
  (store_id, charge_type, label, calculation, percentage, applies_to, min_charge, max_charge, is_active, note)
SELECT id, 'service', 'Online handling fee', 'percentage', 2.50, 'both', 5.00, 45.00, TRUE, 'demo seed'
FROM stores
WHERE store_type = 'online';

-- Physical stores: small card-machine surcharge, charged either way.
INSERT INTO store_charges
  (store_id, charge_type, label, calculation, amount, applies_to, is_active, note)
SELECT id, 'card', 'Card payment surcharge', 'flat', 3.50, 'both', TRUE, 'demo seed'
FROM stores
WHERE store_type IN ('physical', 'mixed');

-- Physical stores: packaging levy that only applies when you collect.
INSERT INTO store_charges
  (store_id, charge_type, label, calculation, amount, applies_to, is_active, note)
SELECT id, 'packaging', 'Shopping bag / packaging', 'flat', 2.00, 'collection', TRUE, 'demo seed'
FROM stores
WHERE store_type IN ('physical', 'mixed');

COMMIT;

-- Sanity check after running:
--   SELECT s.name, c.label, c.calculation, c.amount, c.percentage, c.applies_to
--   FROM store_charges c JOIN stores s ON s.id = c.store_id
--   ORDER BY s.name, c.charge_type;
