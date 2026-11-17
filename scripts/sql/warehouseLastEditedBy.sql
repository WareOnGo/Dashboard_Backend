-- Additive only. Historical editors are unknown, so existing rows retain NULL.
ALTER TABLE "Warehouse" ADD COLUMN IF NOT EXISTS "lastEditedBy" TEXT;

-- statement-breakpoint
ALTER TABLE "StagedWarehouse" ADD COLUMN IF NOT EXISTS "lastEditedBy" TEXT;
