-- Additive only: existing rows retain NULL; no descriptions are generated here.
ALTER TABLE public."Warehouse"
  ADD COLUMN IF NOT EXISTS "ai_description" TEXT;

-- statement-breakpoint
-- Submissions must retain the same field through review and promotion.
ALTER TABLE public."StagedWarehouse"
  ADD COLUMN IF NOT EXISTS "ai_description" TEXT;
