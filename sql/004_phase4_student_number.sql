-- ============================================================
-- Phase 4 — D5: registration can't store residence or student number
-- (see mintly-react/docs/PHASE4_REPORT.md, section D, item 5)
--
-- `residence_area_code` already existed on users (added earlier for
-- Res-Mate bulk-buy matching) but was never wired into RegisterRequest
-- or UserOut. `student_number` didn't exist at all. Both are added
-- here as OPTIONAL, matching the frontend's Register.jsx, which
-- treats them as optional until this backend support landed.
--
-- Safe to run on an existing database (IF NOT EXISTS everywhere).
-- Also folded into sql/schema.sql directly, so a brand-new database
-- created from schema.sql doesn't need this file at all.
-- ============================================================

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS student_number VARCHAR(9);

-- DUT student numbers are 8-9 digits (per the frontend's own
-- validation in src/lib/validation.js). Enforced here too so a
-- request bypassing the frontend (e.g. a direct API call) can't
-- insert a bad value. NULL is allowed — the field is optional.
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS chk_users_student_number_format;
ALTER TABLE users
  ADD CONSTRAINT chk_users_student_number_format
  CHECK (student_number IS NULL OR student_number ~ '^[0-9]{8,9}$');

COMMIT;
