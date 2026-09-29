-- ============================================================
-- Notifications become the single place for every system event
-- (the SMS tab is gone).
--
-- * notifications.module  — WHERE it happened (budget, transactions,
--   shopping_list, profile, account, recommendations, ...).
-- * category is widened to cover events; the old sms_* values stay
--   valid so existing rows are not lost.
--
--   psql -U <user> -d <dbname> -f sql/013_notifications_central.sql
-- Idempotent.
-- ============================================================

BEGIN;

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS module VARCHAR(30) NOT NULL DEFAULT 'system';

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_category_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_category_check
  CHECK (category IN ('sms_in', 'sms_out', 'survival', 'balance', 'system',
                      'success', 'info', 'warning', 'alert'));

-- Rows written by the old SMS mode belong to the "sms" module.
UPDATE notifications SET module = 'sms' WHERE category IN ('sms_in', 'sms_out') AND module = 'system';

COMMIT;
