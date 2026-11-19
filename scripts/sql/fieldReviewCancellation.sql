-- Keep cancellation distinct from verification and release the active-field
-- uniqueness slot. This changes constraints only; review data stays intact.
DO $cancellation$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM pg_constraint
   WHERE conrelid = '"WarehouseFieldFlag"'::regclass
     AND conname = 'WarehouseFieldFlag_status_check'
     AND pg_get_constraintdef(oid) LIKE '%CANCELLED%'
 ) THEN
   ALTER TABLE "WarehouseFieldFlag" DROP CONSTRAINT IF EXISTS "WarehouseFieldFlag_status_check";
   ALTER TABLE "WarehouseFieldFlag" ADD CONSTRAINT "WarehouseFieldFlag_status_check"
     CHECK ("status" IN ('NEEDS_RESPONSE','AWAITING_ADMIN','CHANGES_REQUESTED','VERIFIED','CANCELLED'));
 END IF;
 IF NOT EXISTS (
   SELECT 1 FROM pg_index
   WHERE indexrelid = to_regclass('field_review_one_active_field')
     AND indisvalid AND indisunique
     AND pg_get_expr(indpred,indrelid) LIKE '%CANCELLED%'
 ) THEN
   DROP INDEX IF EXISTS field_review_one_active_field;
   CREATE UNIQUE INDEX field_review_one_active_field ON "WarehouseFieldFlag" ("warehouseId","fieldKey")
     WHERE "status" NOT IN ('VERIFIED','CANCELLED');
 END IF;
END
$cancellation$;
