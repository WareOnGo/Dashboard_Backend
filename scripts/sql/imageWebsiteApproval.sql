-- Website-only results; preserve original media, labels, captions and variants.
ALTER TABLE public.labeled_warehouse_images
  ADD COLUMN IF NOT EXISTS "websiteDecision" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "websiteQualityTier" VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "websiteAssessment" JSONB,
  ADD COLUMN IF NOT EXISTS "websiteAssessedAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "websiteOverride" JSONB,
  ADD COLUMN IF NOT EXISTS "websiteStatus" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "websiteAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "websiteError" TEXT,
  ADD COLUMN IF NOT EXISTS "websiteNextAttemptAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "websiteClaimToken" TEXT,
  ADD COLUMN IF NOT EXISTS "websiteLeaseUntil" TIMESTAMPTZ(3);

-- statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.labeled_warehouse_images'::regclass
    AND conname = 'labeled_warehouse_images_website_status_check') THEN
    ALTER TABLE public.labeled_warehouse_images ADD CONSTRAINT labeled_warehouse_images_website_status_check
      CHECK ("websiteStatus" IN ('PENDING','RUNNING','READY','FAILED','UNSUPPORTED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.labeled_warehouse_images'::regclass
    AND conname = 'labeled_warehouse_images_website_decision_check') THEN
    ALTER TABLE public.labeled_warehouse_images ADD CONSTRAINT labeled_warehouse_images_website_decision_check
      CHECK ("websiteDecision" IN ('PENDING','ALLOW','BLOCK','REVIEW'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.labeled_warehouse_images'::regclass
    AND conname = 'labeled_warehouse_images_website_tier_check') THEN
    ALTER TABLE public.labeled_warehouse_images ADD CONSTRAINT labeled_warehouse_images_website_tier_check
      CHECK ("websiteQualityTier" IS NULL OR "websiteQualityTier" IN ('T1','T2','T3','UNUSABLE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.labeled_warehouse_images'::regclass
    AND conname = 'labeled_warehouse_images_website_ready_check') THEN
    ALTER TABLE public.labeled_warehouse_images ADD CONSTRAINT labeled_warehouse_images_website_ready_check CHECK (
      "websiteStatus" <> 'READY' OR ("websiteDecision" <> 'PENDING' AND "websiteQualityTier" IS NOT NULL
        AND "websiteAssessedAt" IS NOT NULL AND "websiteAssessment" IS NOT NULL
        AND COALESCE("websiteAssessment"->>'sourceSha256','') ~ '^[a-f0-9]{64}$'
        AND COALESCE("websiteAssessment"->>'version','') <> ''
        AND COALESCE("websiteAssessment"->>'model','') <> ''));
  END IF;
END $$;

-- statement-breakpoint
CREATE INDEX IF NOT EXISTS "labeled_warehouse_images_websiteStatus_idx"
  ON public.labeled_warehouse_images ("websiteStatus", "websiteNextAttemptAt");
