# Scout voice notes

Employee-ID scout access is retained for this release by the user's decision on
29 September 2026; a login change is deferred.
See the [adversarial review](../../research/scout-voice-notes-adversarial-review.md)
for findings, fixes, and the remaining processing/deployment work.
Capture defaults to disabled, even when a bucket is configured.

Live database migration applied and verified on 29 September 2026. Both JSONB
columns, the asset table, its three indexes, RLS, and backend-role access are in
place. See [the schema verification record](scout-voice-notes-live-schema.json).
The application uses the existing warehouse-media R2 bucket by the user's request;
API/frontend deployment, capture enablement, and cleanup scheduling remain separate.

Scouts can add one voice recording of up to five minutes alongside written Scout Notes.
Each take is previewed locally before it is added, with playback, deletion, and
upload retry. Completed recordings are stored in IndexedDB until the submission
succeeds. The form keeps its JSON draft and stable voice-draft ID in localStorage.

The recorder is hidden while the slot is occupied. Delete the existing recording
to record again; starting a replacement ends the deleted recording's Undo window.
An older local draft with multiple recordings stays intact and asks the scout to
keep one before submitting. The API also enforces the single-recording limit.

The dashboard review editor and warehouse details provide playback. Editing a
record retains its existing notes unless the edit explicitly removes them.
Manual approval, auto-approval, and reopening retain the canonical recording
references on the appropriate staged/master records.

## Storage and processing

Warehouse.scoutVoiceNotes and StagedWarehouse.scoutVoiceNotes hold canonical
metadata. ScoutVoiceNoteAsset records upload ownership, processing state, and
cleanup leases. Writes from clients carry IDs; storage keys and audio metadata
are resolved by the server. Dashboard/partner creation cannot attach arbitrary
existing recordings.

Audio uses the **existing warehouse-media R2 bucket**, `R2_BUCKET_NAME`, with the
existing credentials and client. Temporary objects use
`scout-voice-note-uploads/<asset-id>/`; normalized recordings use
`scout-voice-notes/<asset-id>/`. Cleanup is scoped to those asset-specific paths.
The bucket's existing public-access policy also applies to audio. The application
still uses signed playback links; those links do not make a public bucket private.
See [R2 public-bucket behavior](https://developers.cloudflare.com/r2/buckets/public-buckets/).
Dashboard playback endpoints require the existing DASHBOARD or REVIEW capability and a
matching record/note association. Scouts can recover playback of their own
unexpired, unattached draft assets when local audio is unavailable. Once an asset
is submitted, the app obtains playback links through the dashboard/reviewer routes.

Upload URLs sign the exact Content-Length and Content-Type; the browser supplies
Content-Length from its Blob. The API downloads at most 10 MiB for verification, checks actual media with
FFprobe, and converts accepted audio to mono AAC in an M4A/MP4 container with
seekable metadata. Only the verified output is published under a final recording
key. Temporary signed uploads cannot overwrite it. Both FFmpeg and FFprobe are
included in the Docker image; install them separately for a non-container host.
Verification is limited to two jobs per Node process with bounded read/decoder
timeouts and codec/filter threads. The container runs as the non-root node user.
These controls do not isolate native decoders from API secrets or replace actual
container resource limits; see the review before enabling production capture.

## Deployment

1. Inspect the shared database with:

   ~~~sh
   node scripts/migrateScoutVoiceNotes.js
   ~~~

   Review scripts/sql/scoutVoiceNotes.sql. Apply only the additive feature
   migration using a connection permitted to change schema:

   ~~~sh
   node scripts/migrateScoutVoiceNotes.js --apply
   npx prisma generate
   ~~~

   The asset table has RLS enabled with no anonymous policies. Use the existing
   trusted server database role; verify that it can read/write this new table.
   Do not replace the shared schema with an unrestricted Prisma db push.

2. Reuse R2_BUCKET_NAME and the existing warehouse-media R2 credentials. They need
   access for GET, HEAD, PUT, DELETE, and listing; no additional bucket is required.
   SCOUT_VOICE_NOTES_ENABLED must explicitly be true to enable capture after the
   migration and deployment checks are complete.

3. Check the existing bucket's R2 CORS for the actual Scout and Dashboard origins, allowing GET,
   HEAD, and PUT, Content-Type and Range request headers, and exposing ETag,
   Content-Length, Content-Range, and Accept-Ranges. Include localhost origins
   only in the development bucket. Signed URLs expire; they are never persisted
   in the warehouse columns.

4. Deploy the API and dashboard consumption UI before enabling the Scout form.
   The Scout asks GET /api/warehouses/scout/voice-notes/configuration whether
   recording is available. Without configuration, text notes continue to work.
   API/body changes and both columns must be deployed together.

5. Schedule this command daily using the existing job runner:

   ~~~sh
   node scripts/cleanupScoutVoiceNotes.js
   ~~~

   Each invocation processes up to 100 expired assets. Monitor the returned
   checked/deleted/failed counts; any failed asset makes the command exit nonzero.
   Alert on failures and run more frequently if a backlog develops.
   Unassociated uploads expire after seven days. Explicitly abandoned uploads
   get a ten-minute grace period, covering their six-minute PUT URLs.
   Cleanup claims each asset, checks both warehouse tables, and only removes
   its final recording when neither references it. Superseded attempts and
   temporary originals are cleaned separately. Rejected staged submissions
   continue to retain their audio.

   Configure an eight-day R2 lifecycle on the scout-voice-note-uploads/ prefix as a backstop for
   abandoned originals and late PUTs after deletion. Never apply an age-only rule
   to the final scout-voice-notes/ prefix. R2 lifecycle execution is asynchronous.
   Upload retries renew registry expiry before receiving a fresh signed URL;
   cleanup renews its deletion lease before each storage operation.

6. Verify a recording from Android Chrome and iPhone Safari in the deployed
   HTTPS environment, including microphone permissions, interruption, playback
   in the reviewer browser, and upload retry.

Rollback can disable new captures while keeping saved-note playback available.
Retain the additive columns, asset registry, and audio files.

## API

- GET /api/warehouses/scout/voice-notes/configuration: feature availability and limits.
- POST /api/warehouses/scout/voice-notes/uploads: scout verification, draft/recording ID,
  MIME type and bytes; returns a temporary signed upload URL or an existing ready note.
- POST /api/warehouses/scout/voice-notes/uploads/:id/complete: verify, normalize, finalize.
- DELETE /api/warehouses/scout/voice-notes/uploads/:id: abandon an unattached owned upload.
- GET /api/warehouses/scout/voice-notes/uploads/:id/playback: restore owned draft playback.
- GET /api/staging/:id/voice-notes/:noteId/playback: authorized review playback.
- GET /api/warehouses/:id/voice-notes/:noteId/playback: authorized warehouse playback.

Omitting scoutVoiceNotes in an update preserves its value. An explicit empty
array removes associations. Saved audio stays outside photos, images/videos/docs,
image classification, and marketing exports. Deleting a note from a dashboard
edit changes its association only when the parent edit is saved.

## Verification

Local verification completed on 29 September 2026:

- Backend: 124 tests passed across upload/attachment services, real FFmpeg media
  normalization, authorized routes, staging, warehouse updates, and file validation.
- Scout: 35 tests passed across the recording UI and existing form behavior.
- Dashboard: 32 tests passed across playback, editing, and warehouse details.
- Both frontend production builds passed. Focused ESLint checks passed for the
  new frontend modules, and Prisma schema validation passed.
- Chrome captured and played synthetic microphone audio at 320px and 390px
  widths, including a forced WebM fallback. All three browser scenarios passed,
  with no horizontal overflow or browser errors and 48px custom action buttons.

Automated application checks use mocked APIs/storage and synthetic audio. The
live migration was separately applied and its schema/RLS/backend permissions
verified. Production bucket/CORS behavior and physical iPhone/Android behavior
have not been verified by those automated checks. The shared-bucket follow-up
reran 79 backend service, route, and staging regression tests successfully.

Backend coverage includes ownership, actual-byte validation, normalization,
upload/submission retries, invalid attachments, staged promotion mapping,
canonical edit preservation, playback association, and reference-aware cleanup.
The duration checks preserve a complete five-minute recording in normalized
playback and reject an over-limit file. A second attachment is rejected before
the submission is saved.
Scout component tests cover preview before upload, microphone cancellation and
denial, timer auto-stop, interrupted uploads, delete/Undo races, storage failures,
restored previews, the five-minute stop, and the single recording slot.
Dashboard tests cover signed playback and retained notes.

The browser smoke test is Eval_Harness/scripts/scout-voice-notes-mobile.mjs.
It uses a local Vite server and a local Chrome CDP instance with fake-media
capture. Every API request is mocked. It checks 320px and 390px layouts, actual
capture/playback, seeking, reload recovery, failed-upload retry, deletion/Undo,
submission payloads, and the WebM fallback. Reports/screenshots are written to
Eval_Harness/artifacts/scout-voice-notes.
It also exercises migration of old IndexedDB drafts, preservation of unrelated
drafts during cleanup, and re-upload before submission after server expiry.

Run the targeted checks from their corresponding repository directories:

~~~sh
# Backend_Repository
npm test -- --runInBand tests/services/voiceNoteService.test.js tests/utils/voiceNoteMedia.test.js tests/routes/voiceNotes.test.js tests/services/stagingService.test.js tests/models/stagedWarehouseModelPromote.test.js tests/services/warehouseReadOnlyFields.test.js tests/routes/warehouse.test.js tests/regression/fileValidation.test.js
npx prisma validate

# Scout_Frontend
npx vitest run src/components/VoiceNotesInput.test.jsx src/components/WarehouseForm.test.jsx
npm run build

# Frontend_Repository
npx vitest run src/components/__tests__/VoiceNotesList.test.jsx src/components/__tests__/WarehouseForm.test.jsx src/components/__tests__/WarehouseDetailsModalImages.test.jsx
npm run build
~~~

Transcription, waveforms, audio importing, trimming, and pause/resume recording
are outside this release. Voice-only content currently has no equivalent text
transcript; an optional written-notes field does not resolve that accessibility
gap. Browser storage is best-effort, and an unfinished take cannot always be
recovered after the OS terminates a page.
