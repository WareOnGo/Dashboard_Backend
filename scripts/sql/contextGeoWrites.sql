-- Only the authenticated server database role may read/write these receipts.
-- Retain completed operation receipts to prevent duplicate POIs after later retries.
CREATE TABLE IF NOT EXISTS public."ContextGeoWrite" (
  issuer TEXT NOT NULL CHECK (issuer = 'wareongo:context-engine'),
  "employeeId" INTEGER NOT NULL CHECK ("employeeId" > 0),
  "operationId" UUID NOT NULL,
  "bodyHash" TEXT NOT NULL CHECK ("bodyHash" ~ '^[A-Za-z0-9_-]{43}$'),
  "pointId" TEXT NOT NULL,
  result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 32768),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (issuer, "employeeId", "operationId")
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS public."ContextGeoNonce" (
  hash TEXT PRIMARY KEY CHECK (hash ~ '^[A-Za-z0-9_-]{43}$'),
  "expiresAt" TIMESTAMPTZ(3) NOT NULL
);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS "ContextGeoNonce_expiresAt_idx" ON public."ContextGeoNonce" ("expiresAt");
-- statement-breakpoint
ALTER TABLE public."ContextGeoWrite" ENABLE ROW LEVEL SECURITY;
-- statement-breakpoint
ALTER TABLE public."ContextGeoNonce" ENABLE ROW LEVEL SECURITY;
-- statement-breakpoint
REVOKE ALL ON public."ContextGeoWrite",public."ContextGeoNonce" FROM PUBLIC;
-- statement-breakpoint
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON public."ContextGeoWrite",public."ContextGeoNonce" FROM %I',role_name);
    END IF;
  END LOOP;
END $$;

-- statement-breakpoint
-- Immutable compensation receipts. No point FK: retries must survive deletion.
CREATE TABLE IF NOT EXISTS public."ContextGeoRollback" (
  issuer TEXT NOT NULL CHECK (issuer = 'wareongo:context-engine'),
  "employeeId" INTEGER NOT NULL CHECK ("employeeId" > 0),
  "operationId" UUID NOT NULL,
  "originalOperationId" UUID NOT NULL,
  "pointId" TEXT NOT NULL,
  result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 32768),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (issuer, "employeeId", "operationId"),
  UNIQUE (issuer, "employeeId", "originalOperationId"),
  CHECK ("operationId" <> "originalOperationId"),
  FOREIGN KEY (issuer, "employeeId", "originalOperationId")
    REFERENCES public."ContextGeoWrite" (issuer, "employeeId", "operationId")
);
-- statement-breakpoint
ALTER TABLE public."ContextGeoRollback" ENABLE ROW LEVEL SECURITY;
-- statement-breakpoint
REVOKE ALL ON public."ContextGeoRollback" FROM PUBLIC;
-- statement-breakpoint
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON public."ContextGeoRollback" FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
