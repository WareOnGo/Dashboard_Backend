-- Targeted migration only. No Warehouse alterations, deletes, or media rewrites.
-- READY remains the default for older label writers during the rolling upgrade.
-- New registration code explicitly inserts PENDING.
ALTER TABLE public.labeled_warehouse_images
  ALTER COLUMN classification DROP NOT NULL,
  ALTER COLUMN model DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "webpUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "webpObjectKey" TEXT,
  ADD COLUMN IF NOT EXISTS "webpBytes" BIGINT,
  ADD COLUMN IF NOT EXISTS "webpAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "webpStatus" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "webpError" TEXT,
  ADD COLUMN IF NOT EXISTS "webpCheckedAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "webpVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "labelStatus" VARCHAR(16) NOT NULL DEFAULT 'READY',
  ADD COLUMN IF NOT EXISTS "labelledAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "labelAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "labelError" TEXT,
  ADD COLUMN IF NOT EXISTS "labelNextAttemptAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "labelClaimToken" TEXT,
  ADD COLUMN IF NOT EXISTS "labelLeaseUntil" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "documentStatus" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "documentAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "documentError" TEXT,
  ADD COLUMN IF NOT EXISTS "documentNextAttemptAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "documentClaimToken" TEXT,
  ADD COLUMN IF NOT EXISTS "documentLeaseUntil" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "webpAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "webpNextAttemptAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "webpClaimToken" TEXT,
  ADD COLUMN IF NOT EXISTS "webpLeaseUntil" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "unreferencedAt" TIMESTAMPTZ(3);

-- statement-breakpoint
-- Copy existing backfill results without renaming/removing any legacy columns.
UPDATE public.labeled_warehouse_images SET
  "webpUrl" = "compressedImageUrl", "webpObjectKey" = "compressedObjectKey",
  "webpBytes" = "compressedBytes", "webpAt" = "compressedAt",
  "webpStatus" = CASE WHEN "compressionStatus" = 'RUNNING' THEN 'PENDING' ELSE "compressionStatus" END,
  "webpError" = "compressionError", "webpCheckedAt" = "compressionCheckedAt", "webpVersion" = "compressionVersion"
WHERE "webpUrl" IS NULL AND "webpCheckedAt" IS NULL AND "webpStatus" = 'PENDING'
  AND "webpAttempts" = 0 AND "webpClaimToken" IS NULL;

-- statement-breakpoint
UPDATE public.labeled_warehouse_images SET "labelledAt" = "createdAt"
WHERE classification IS NOT NULL AND "labelledAt" IS NULL;

-- statement-breakpoint
UPDATE public.labeled_warehouse_images SET "documentStatus" = 'READY'
WHERE "documentKind" IS NOT NULL AND "documentStatus" = 'PENDING';

-- statement-breakpoint
DO $$
DECLARE stage text;
BEGIN
  FOREACH stage IN ARRAY ARRAY['label', 'document', 'webp'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.labeled_warehouse_images'::regclass
      AND conname = 'labeled_warehouse_images_' || stage || '_status_check') THEN
      EXECUTE format('ALTER TABLE public.labeled_warehouse_images ADD CONSTRAINT %I CHECK (%I IN (''PENDING'', ''RUNNING'', ''READY'', ''FAILED'', ''UNSUPPORTED''))',
        'labeled_warehouse_images_' || stage || '_status_check', stage || 'Status');
    END IF;
  END LOOP;
END $$;

-- statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.labeled_warehouse_images'::regclass AND conname = 'labeled_warehouse_images_webp_ready_check') THEN
    ALTER TABLE public.labeled_warehouse_images ADD CONSTRAINT labeled_warehouse_images_webp_ready_check CHECK (
      "webpStatus" <> 'READY' OR ("storageBucket" IS NOT NULL AND "webpUrl" IS NOT NULL
        AND "webpObjectKey" IS NOT NULL AND "webpBytes" IS NOT NULL AND "webpBytes" > 0
        AND "webpUrl" ~* '\.webp([?#].*)?$'));
  END IF;
END $$;

-- statement-breakpoint
CREATE INDEX IF NOT EXISTS "labeled_warehouse_images_webpStatus_idx" ON public.labeled_warehouse_images ("webpStatus");

-- statement-breakpoint
CREATE INDEX IF NOT EXISTS "labeled_warehouse_images_labelStatus_idx" ON public.labeled_warehouse_images ("labelStatus");

-- statement-breakpoint
CREATE INDEX IF NOT EXISTS "labeled_warehouse_images_documentStatus_idx" ON public.labeled_warehouse_images ("documentStatus");

-- statement-breakpoint
-- Same parsing contract as src/utils/imageContract.cjs, tested against fixtures.
-- SECURITY INVOKER: callers retain their existing Warehouse access permissions.
CREATE OR REPLACE FUNCTION public.wareongo_image_urls(raw_media jsonb, raw_photos text)
RETURNS text[] LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
DECLARE m jsonb := raw_media; p jsonb; entry jsonb; value text; part text; path text;
  result text[] := ARRAY[]::text[]; i integer;
BEGIN
  FOR i IN 1..2 LOOP
    EXIT WHEN jsonb_typeof(m) IS DISTINCT FROM 'string';
    BEGIN m := (m #>> '{}')::jsonb; EXCEPTION WHEN invalid_text_representation THEN EXIT; END;
  END LOOP;
  IF jsonb_typeof(m->'images') = 'array' THEN p := m->'images';
  ELSE
    p := to_jsonb(raw_photos);
    FOR i IN 1..2 LOOP
      EXIT WHEN jsonb_typeof(p) IS DISTINCT FROM 'string';
      BEGIN p := (p #>> '{}')::jsonb; EXCEPTION WHEN invalid_text_representation THEN EXIT; END;
    END LOOP;
  END IF;
  IF p IS NULL THEN RETURN result; END IF;
  IF jsonb_typeof(p) <> 'array' THEN p := jsonb_build_array(p); END IF;
  FOR entry IN SELECT jsonb_array_elements(p) LOOP
    CONTINUE WHEN jsonb_typeof(entry) <> 'string';
    value := entry #>> '{}';
    FOREACH part IN ARRAY regexp_split_to_array(value, ',\s*(?=https?://)', 'i') LOOP
      part := btrim(part);
      CONTINUE WHEN part !~* '^https?://[^/\s@?#]+/.+';
      path := regexp_replace(part, '[?#].*$', '');
      IF (path ~* '\.(jpe?g|png|webp|gif|avif|bmp|tiff?|heic|heif|svg)$' OR path !~ '\.[^/.]+$')
        AND NOT (part = ANY(result)) THEN result := array_append(result, part); END IF;
    END LOOP;
  END LOOP;
  RETURN result;
END $$;
