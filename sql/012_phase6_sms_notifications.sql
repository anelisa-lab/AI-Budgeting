-- ============================================================
-- Phase 6 — SMS mode + a Notifications tab
--
-- Two things a student needs to be told without opening the app: an SMS
-- short-code system (POST /sms/reply) they can text UniWallet's commands to,
-- and an in-app "Notifications" tab that mirrors every one of those
-- exchanges (plus app-triggered alerts, like crossing into survival mode) so
-- the same message is never seen on the phone but lost in the app, or the
-- other way round.
--
-- users.phone_number already exists in schema.sql but nothing wrote to it or
-- read it; this adds the on/off switch and the low-balance trigger next to
-- it, and a table to hold the notification log itself.
--
--   psql -U <user> -d <dbname> -f sql/012_phase6_sms_notifications.sql
-- Idempotent: safe to run more than once.
-- ============================================================

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS sms_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sms_low_balance_threshold NUMERIC(12,2)
  CONSTRAINT chk_users_sms_low_balance_threshold_positive
  CHECK (sms_low_balance_threshold IS NULL OR sms_low_balance_threshold >= 0);

-- One row per message the student would see, whether it started as an
-- inbound SMS command, the reply to one, or an app-triggered alert (e.g.
-- "you're in survival mode now"). channel/sms_status record what actually
-- happened to a phone; a notification with channel='app' never touched SMS
-- at all (sms_status stays NULL).
CREATE TABLE IF NOT EXISTS notifications (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category     VARCHAR(30) NOT NULL DEFAULT 'system'
               CHECK (category IN ('sms_in', 'sms_out', 'survival', 'balance', 'system')),
  channel      VARCHAR(10) NOT NULL DEFAULT 'app'
               CHECK (channel IN ('app', 'sms')),
  title        VARCHAR(150) NOT NULL,
  body         TEXT NOT NULL,
  -- 'sent' (a real gateway accepted it), 'simulated' (no gateway configured —
  -- logged, not actually texted), 'no_phone', 'disabled' (sms_enabled=false)
  -- or 'failed'. NULL for channel='app'.
  sms_status   VARCHAR(20),
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications (user_id) WHERE read_at IS NULL;

COMMIT;
