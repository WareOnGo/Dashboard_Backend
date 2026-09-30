-- Additive migration only. Admin inheritance is resolved in application code;
-- existing employees receive no explicit Analyst grant.
ALTER TABLE public."VerifiedNumber"
    ADD COLUMN IF NOT EXISTS "analystAccess" boolean NOT NULL DEFAULT false;
