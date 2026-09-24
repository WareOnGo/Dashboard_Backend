**Deployment update, 24 September:** This is the original design plan. The
implementation now runs automatically without read/write feature flags. Follow the
[current deployment notes](image-pipeline-production-rollout.md) for release steps.

**Implementation update, 22 September:** See [local rollout notes](image-pipeline-local-rollout.md). WebP now has explicit `webp*` fields; generic compression fields are retained for compatibility.

**Image pipeline cutover plan — proposed, 21 September 2026**

Use the extended `labeled_warehouse_images` table for original URLs, compressed
variants, labels and captions. This plan changes producers and consumers in
stages. Queue infrastructure is a subsequent rollout; the first rollout retains
the existing image-label and WebP job triggers.

The completed backfill is the starting point: 15,699 label rows, of which 14,617
have matching R2 WebPs and 1,082 have compression status PENDING. The inventory
also found 31 original URLs without label rows. These are observations from the
backfill, not fixed acceptance counts for a changing catalogue.

| Responsibility | Owner after cutover |
| --- | --- |
| Register images referenced by accepted warehouse records | Dashboard backend; reconciliation covers other writers |
| Classification, caption and document subtype | Dashboard backend |
| WebP conversion and compression metadata | Website backend |
| Read image metadata | Both backends, directly from the shared table |
| Image membership and ordering | Warehouse media, with the defined legacy fallback |

Both processors update only their own columns. Successful classification must
not overwrite compression metadata; compression must not replace a caption or
label. Page requests perform database reads only.

1. **Establish image identity, membership and processing states.**

   Keep the existing table name, integer ID, unique `imageUrl`, and `description`
   field. `imageUrl` remains the original URL; the API can expose `description`
   as `caption`. `warehouseId` on this table remains provenance, not an exclusive
   ownership relation: an original can be referenced by several warehouses.

   Use a valid `media.images` array as the ordered reference list. When this is
   absent, parse legacy `photos` (CSV, JSON arrays and legacy mixed entries).
   An explicitly empty images array is authoritative; do not resurrect removed
   images from an older photos value. Normalize supported serialized media and
   distinguish non-image files. Resolve disagreements in a dry-run report before
   changing gallery membership. Use the same fixtures and rules in both repos.

   Add `labelStatus`, `labelledAt`, and the stage-specific retry/error and lease
   metadata needed to recover interrupted work. Track missing document subtypes
   separately from a completed scene label. Allow `classification` and `model`
   to be null for a registered image that has not been classified. UNKNOWN is a
   completed classification, never a substitute for PENDING.

   Preserve existing successful labels as READY, and initialize their label
   timestamps from the existing record timestamps. Existing WebPs with a null
   `compressionVersion` remain usable; unknown historical settings are not a
   reason to recompress the catalogue.

   Apply only targeted schema changes and synchronize both Prisma models. The
   website repo already has a `labeled_warehouse_images` model, but lacks the
   newly added compression fields. The dashboard model is `LabeledWarehouseImage`.

2. **Deploy compatibility code before creating unlabelled rows.**

   The current label service identifies work using NOT EXISTS and persists with
   createMany/skipDuplicates. A placeholder row would therefore be skipped
   forever. Change discovery to explicit labeling state and missing results,
   and change persistence to conditional updates/upserts of label columns only.
   Update coverage/statistics to distinguish total registered images from
   successfully labeled images.

   Deploy the nullable-aware dashboard backend first, then the website backend.
   Registration is automatic in the new versions. Drain old label runs and avoid
   overlapping old/new label workers during the switch. Keep a compatible READY
   default for legacy inserts; new registrations explicitly use PENDING and
   successful classifier writes become READY.

   Replace the current media-only stale-row deletion before enabling registration.
   It must use the same membership rules, including legacy-only references and
   shared URLs. Prefer marking unreferenced rows for later retention cleanup;
   do not let the label sweep delete another processor's active record.

   Relevant dashboard code: `src/models/imageLabelModel.js`,
   `src/services/imageLabelService.js`, `src/services/warehouseEnrichmentService.js`.
   The enrichment endpoint's proximity stage and schedule remain independent.

3. **Enable forward-fill registration and the two producers.**

   Register image references after successful warehouse creation/promotion and
   on image edits. This includes the separate staging promotion path in
   `src/models/stagedWarehouseModel.js`, ordinary writes in
   `src/models/warehouseModel.js`, and partner/scout submissions that reach
   those paths. Issuing an upload URL does not count as an attached image.

   Upsert by original URL without resetting any successful result. Registration
   performs no model calls or conversion. Reconciliation before selecting work
   catches direct database imports, missed registrations and transient write
   failures. Investigate and register the 31 currently missing image records
   through the same rules instead of maintaining a separate special-case list.

   Dashboard processing selects due label work, calls the existing classifier,
   and stores the label/caption/confidence/model on that row. A failed document
   subtype gets its own retry; it does not repeat the scene classification.

   Website processing selects due compression work from the shared table.
   Reuse a verified matching R2 object when present; otherwise run the existing
   Sharp child process and upload it before publishing its URL and READY state.
   Preserve the current byte/pixel limits, serial decoder, memory checks and
   time budgets. Retain original files and preserve the last successful variant
   when a later conversion attempt fails.

   Process images referenced by all current warehouses, prioritizing visible
   listings before hidden/internal stock. Public API visibility rules still
   apply independently. The current visible-only compression scope would leave
   some dashboard images permanently pending.

   Keep current run locks, add conditional per-image claims with expiry, and
   publish results only for the claim/version still owned by that attempt.
   Retry transient failures with backoff; report exhausted or unsupported
   inputs without spinning forever on them. Restarting work must reuse completed
   files/results. Define these as reusable `labelOne` and `compressOne` operations
   so a future queue can call them unchanged.

   Website files: `services/webpCompression.js`, `services/warehouseWebpService.js`,
   `services/webpJob.js`, `services/webpImageProcess.js`, `services/webpImageWorker.js`.
   Preserve the existing `/maintenance/webp` interface and document its new
   table-driven progress/cursor semantics. Do not reuse a warehouse cursor as
   an image cursor without migrating/resetting its namespace.

   During the rollback window, project successful variants back into
   `Warehouse.photosWebp` for old consumers. This is a compatibility projection
   from the shared table, not an independent compression pipeline. Repair a
   failed projection without recompressing; protect concurrent photo edits.

4. **Add the same ordered image response to both backends.**

   Example per-image object:

   ```json
   {
     "id": 123,
     "originalUrl": "https://images.example/original.jpg",
     "webpUrl": "https://images.example/webp/original.webp",
     "displayUrl": "https://images.example/webp/original.webp",
     "classification": "INDOOR",
     "documentKind": null,
     "caption": "Warehouse interior with steel roof trusses."
   }
   ```

   Return one `images` array in warehouse order. Resolve metadata by original
   URL, not the provenance warehouseId. Missing rows still produce an object
   with a null ID/label/variant and the original as displayUrl. A retry must not
   hide an already successful compressed URL; processing status describes the
   current attempt, while a stored successful variant remains usable.

   Use one bulk lookup per page/ID batch, not one query per image or warehouse.
   Preserve compatibility fields while consumers upgrade. Convert/omit BigInt
   byte sizes during JSON serialization; keep storage and worker internals out
   of the public display object. Use a common serializer contract and fixtures
   for the two APIs.

   Dashboard: extend `attachImageLabels`, bulk lookups and the single-warehouse
   endpoint. Include documentKind consistently in both paths; the current
   single-warehouse service omits it. Retain the current opt-in behavior for
   full-table consumers that do not need images.

   Website: update both list queries/formatting and the separately implemented
   detail controller. Maintain their existing visibility checks and explicit
   response field selection. Version the Redis cache key when the response
   changes. Compare counts, ordering and pairs against the legacy fields when
   checking the automatically enabled image response.

5. **Move galleries to explicit pairs and validate the cutover.**

   Update the website transforms and gallery helpers to consume `images` directly.
   The new path must not infer fallback identity from filename stems. Retain
   the existing bounded WebP-to-original fallback, load/error handling and lazy
   loading. Keep the legacy parsing path for older API responses during rollout.

   In the dashboard, show compressed previews with original-image fallback;
   group and caption by the original image identity. Keep PPT/CAD/Excel
   selections submitted as original URLs for now. Their membership checks and
   high-resolution export behavior must not break when thumbnail URLs change.

   Invalidate website response caches after committed compression or labeling
   batches, with TTL as a fallback. Establish one authenticated invalidation
   path for dashboard-originated label updates instead of sending a request per
   image. Rebuild the static website once after the initial read cutover. Later
   static pages still follow the current build cadence during this rollout;
   instantaneous queue completion does not by itself refresh generated HTML.

   Verify the automatic reads on a small representative set in both backends.
   Keep legacy projections until both frontends and exports
   have passed their checks and one normal processing cycle has completed.

   Acceptance cases: original-only image, compressed-only progress while label
   is pending, label-only progress while compression fails, missing WebP object,
   shared image across warehouses, reordered/removed photos, legacy-only photos,
   mixed videos/docs, document subtype retry, concurrent edit, worker restart,
   duplicate run, cache refresh, and original-based PPT/Excel selection.
   All real input images must remain represented, bulk requests must stay
   bounded, and old captions/labels must survive compression writes.

   Completion requires new submissions and direct edits to be automatically
   registered/processed, both APIs to return matching image metadata, and every
   current gap to be either successfully filled or explicitly reported with a
   retry/failure reason. Unreadable sources do not require a misleading claim
   of zero failures to permit original-image fallback.

6. **Retire legacy paths, then switch triggering to queues.**

   After consumer verification, stop reading and writing `Warehouse.photosWebp`
   and remove the obsolete positional/filename pairing logic. Retain the column
   through the rollback window; drop it only after checking remaining consumers.
   Original membership in `media`/legacy `photos` is a separate concern from the
   compressed-variant column and is not removed in this cutover.

   Queue registration and processing can then reuse the same image IDs, stage
   states and per-image operations. Enqueue only unfinished work in the same
   transaction as registration (or through a transactional outbox), acknowledge
   after results are committed, and tolerate redelivery. Use separately bounded
   compression and labeling concurrency and document-subtype follow-up jobs.

   Run consumers as durable worker processes. Keep periodic reconciliation as
   a repair mechanism. Replace only image-processing cron triggers: proximity
   enrichment and the nightly site build have separate responsibilities. If
   faster publication is desired, add a debounced build-only completion trigger;
   calling the current CMS `/api/deploy` on compression completion would start
   compression again and must not become a callback loop.

**Deployment order and rollback**

Apply the targeted compatible schema, deploy the dashboard backend after old
label runs drain, then deploy the website backend and frontend consumers. Reads
and writes activate automatically. Verify results and rebuild the static site.
Retiring compatibility projections and moving triggers to queues are later work.

If processing needs to stop, pause its existing trigger. Keep the nullable/status-
aware backend version deployed after pending rows have been introduced: reverting
to the old row-existence label logic would strand pending images. Keep originals,
successful variants and existing label results intact throughout the rollout.
