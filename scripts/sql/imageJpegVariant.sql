-- Add a separate JPEG result. Existing columns and rows
-- (including Warehouse.media, labels and WebP results) are never rewritten.
ALTER TABLE public.labeled_warehouse_images
  ADD COLUMN IF NOT EXISTS "jpegUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "jpegBytes" BIGINT,
  ADD COLUMN IF NOT EXISTS "jpegAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "jpegVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "jpegStatus" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "jpegError" TEXT;

-- statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.labeled_warehouse_images'::regclass
    AND conname = 'labeled_warehouse_images_jpeg_status_check') THEN
    ALTER TABLE public.labeled_warehouse_images ADD CONSTRAINT labeled_warehouse_images_jpeg_status_check
      CHECK ("jpegStatus" IN ('PENDING', 'READY', 'FAILED', 'UNSUPPORTED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.labeled_warehouse_images'::regclass
    AND conname = 'labeled_warehouse_images_jpeg_ready_check') THEN
    ALTER TABLE public.labeled_warehouse_images ADD CONSTRAINT labeled_warehouse_images_jpeg_ready_check CHECK (
      "jpegStatus" <> 'READY' OR ("jpegUrl" IS NOT NULL AND "jpegUrl" ~* '\.jpe?g([?#].*)?$'
        AND "jpegBytes" IS NOT NULL AND "jpegBytes" > 0
        AND "jpegVersion" IS NOT NULL AND "jpegAt" IS NOT NULL));
  END IF;
END $$;

-- statement-breakpoint
CREATE INDEX IF NOT EXISTS "labeled_warehouse_images_jpegStatus_idx"
  ON public.labeled_warehouse_images ("jpegStatus");
