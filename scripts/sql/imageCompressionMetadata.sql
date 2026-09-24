-- Additive extension of the existing label table. Run through
-- scripts/backfillImageCompression.js --apply; no Prisma db push is needed.
ALTER TABLE public.labeled_warehouse_images
  ADD COLUMN IF NOT EXISTS "storageBucket" TEXT,
  ADD COLUMN IF NOT EXISTS "originalObjectKey" TEXT,
  ADD COLUMN IF NOT EXISTS "compressedImageUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "compressedObjectKey" TEXT,
  ADD COLUMN IF NOT EXISTS "compressedBytes" BIGINT,
  ADD COLUMN IF NOT EXISTS "compressedAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "compressionStatus" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "compressionError" TEXT,
  ADD COLUMN IF NOT EXISTS "compressionCheckedAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "compressionVersion" TEXT;

-- statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.labeled_warehouse_images'::regclass
      AND conname = 'labeled_warehouse_images_compression_status_check'
  ) THEN
    ALTER TABLE public.labeled_warehouse_images
      ADD CONSTRAINT labeled_warehouse_images_compression_status_check
      CHECK ("compressionStatus" IN ('PENDING', 'RUNNING', 'READY', 'FAILED', 'UNSUPPORTED'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.labeled_warehouse_images'::regclass
      AND conname = 'labeled_warehouse_images_compression_ready_check'
  ) THEN
    ALTER TABLE public.labeled_warehouse_images
      ADD CONSTRAINT labeled_warehouse_images_compression_ready_check
      CHECK ("compressionStatus" <> 'READY' OR (
        "storageBucket" IS NOT NULL AND "compressedImageUrl" IS NOT NULL
        AND "compressedObjectKey" IS NOT NULL AND "compressedBytes" IS NOT NULL
        AND "compressedBytes" > 0
      ));
  END IF;
END $$;

-- statement-breakpoint
CREATE INDEX IF NOT EXISTS "labeled_warehouse_images_compressionStatus_idx"
  ON public.labeled_warehouse_images ("compressionStatus");
