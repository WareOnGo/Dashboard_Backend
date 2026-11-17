ALTER TABLE public."Warehouse" ADD COLUMN IF NOT EXISTS "scoutVoiceNotes" JSONB NOT NULL DEFAULT '[]'::jsonb;
-- statement-breakpoint
ALTER TABLE public."StagedWarehouse" ADD COLUMN IF NOT EXISTS "scoutVoiceNotes" JSONB DEFAULT '[]'::jsonb;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS public."ScoutVoiceNoteAsset" (
  "id" TEXT PRIMARY KEY,
  "scoutId" INTEGER NOT NULL,
  "clientRecordingId" TEXT NOT NULL,
  "draftId" TEXT NOT NULL,
  "uploadKey" TEXT NOT NULL,
  "storageKey" TEXT,
  "contentType" TEXT NOT NULL,
  "expectedSize" INTEGER NOT NULL,
  "sizeBytes" INTEGER,
  "durationMs" INTEGER,
  "state" TEXT NOT NULL DEFAULT 'UPLOADING',
  "operationToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ScoutVoiceNoteAsset_scoutId_clientRecordingId_key"
  ON public."ScoutVoiceNoteAsset" ("scoutId", "clientRecordingId");
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS "ScoutVoiceNoteAsset_state_expiresAt_idx"
  ON public."ScoutVoiceNoteAsset" ("state", "expiresAt");
-- statement-breakpoint
ALTER TABLE public."ScoutVoiceNoteAsset" ENABLE ROW LEVEL SECURITY;
