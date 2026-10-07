-- Additive only: an existing listing does not establish when availability was checked.
ALTER TABLE public."Warehouse"
  ADD COLUMN IF NOT EXISTS "availabilityLastReviewedOn" DATE;

-- statement-breakpoint
-- Preserve the actual check date through submission review and promotion.
ALTER TABLE public."StagedWarehouse"
  ADD COLUMN IF NOT EXISTS "availabilityLastReviewedOn" DATE;
