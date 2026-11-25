-- QA owns its snapshots and events. No warehouse columns, triggers or data change.
CREATE TABLE IF NOT EXISTS "WarehouseQaRun" (
  "id" TEXT PRIMARY KEY, "requestHash" TEXT NOT NULL, "actor" JSONB NOT NULL,
  "metadata" JSONB NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS "WarehouseQaItem" (
  "runId" TEXT NOT NULL REFERENCES "WarehouseQaRun"("id"), "warehouseId" INTEGER NOT NULL,
  "status" TEXT NOT NULL CHECK ("status" IN ('QUEUED','RUNNING','COMPLETED','FAILED','SKIPPED')),
  "snapshot" JSONB NOT NULL, "result" JSONB, "artifact" JSONB,
  "attempts" INTEGER NOT NULL DEFAULT 0, "availableAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "leaseToken" TEXT, "leaseUntil" TIMESTAMPTZ, "dedupKey" TEXT UNIQUE, "error" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("runId", "warehouseId")
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS "WarehouseQaItem_queue" ON "WarehouseQaItem"("status","availableAt","leaseUntil");
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS "WarehouseQaItem_warehouse" ON "WarehouseQaItem"("warehouseId","createdAt" DESC);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS "WarehouseQaEvent" (
  "id" TEXT PRIMARY KEY, "runId" TEXT NOT NULL REFERENCES "WarehouseQaRun"("id"),
  "warehouseId" INTEGER, "actor" JSONB NOT NULL, "action" TEXT NOT NULL,
  "requestId" TEXT UNIQUE, "requestHash" TEXT, "payload" JSONB NOT NULL, "response" JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS "WarehouseQaEvent_item" ON "WarehouseQaEvent"("runId","warehouseId","createdAt" DESC);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS "WarehouseQaCache" (
  "key" TEXT PRIMARY KEY, "data" JSONB NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS "WarehouseQaCursor" (
  "id" TEXT PRIMARY KEY, "data" JSONB NOT NULL, "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- statement-breakpoint
DO $$ DECLARE t TEXT; role_name TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['WarehouseQaRun','WarehouseQaItem','WarehouseQaEvent','WarehouseQaCache','WarehouseQaCursor'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',t);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',t,role_name);
      END IF;
    END LOOP;
  END LOOP;
END $$;
