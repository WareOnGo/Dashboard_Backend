**Image pipeline implementation — 22 September 2026**

`Warehouse.media` remains present and authoritative. This migration never alters
the Warehouse table or rewrites any warehouse values. Runtime processors only
update image metadata and the temporary `photosWebp` compatibility projection;
that projection compares media/photos against its snapshot before writing.

`labeled_warehouse_images` remains the single image table. `imageUrl` identifies
the original file; originals remain stored at their existing URLs. A shared URL
has one result even when several warehouses reference it. The table's warehouseId
is provenance, not exclusive ownership or gallery order.

WebP is explicit: `webpUrl`, `webpObjectKey`, `webpBytes`, `webpAt`, `webpVersion`,
`webpStatus` and WebP-specific attempt/lease/error fields. Separate JPEG variants
are supported by the manual [JPEG pilot and backfill](jpeg-ppt-pilot.md), not the scheduled workers.
The initial generic compression columns are retained unchanged for compatibility.
The migration copies their reusable results into the WebP fields without making
model calls, converting images or uploading objects.

Both API serializers return ordered image objects:

```json
{
  "id": 123,
  "originalUrl": "https://images.example/original.jpg",
  "webpUrl": "https://images.example/webp/images/hash/sharp-w1280-q75-v1.webp",
  "jpegUrl": "https://images.example/jpeg/images/hash/jpeg-1280-q82-progressive-420-v1/content.jpg",
  "displayUrl": "https://images.example/webp/images/hash/sharp-w1280-q75-v1.webp",
  "classification": "INDOOR",
  "documentKind": null,
  "caption": "Warehouse interior."
}
```

Rows without metadata still appear with the original URL. Worker state is not
included in the public response. A previous successful variant remains available
during a retry. Galleries use explicit pairs; export selections use originals.
Legacy photos support CSV, arrays, JSON strings and mixed video/document entries.
A valid empty media.images array prevents old photos from reappearing.

**Local configuration and checks**

Both backends use the shared image table automatically. Reads, registration and
the label/WebP workers need no feature flags or new environment settings.

For optional immediate invalidation, set the dashboard's `IMAGE_PIPELINE_CACHE_URL`
to the website backend's HTTPS `/maintenance/image-cache` endpoint. It uses an HMAC scoped to cache invalidation, derived from the shared R2
secret. Calls are batched; failed invalidations fall back to the existing cache
TTL. Local tests use fixtures and never invoke live OpenAI or R2 writes.

Local PostgreSQL uses Podman and the dedicated database checked by the test
harness. Example commands from the dashboard backend:

```sh
podman run --detach --name wareongo-image-pipeline-test \
  --publish 127.0.0.1:55439:5432 \
  --env POSTGRES_USER=warehouse_test --env POSTGRES_PASSWORD=warehouse_test \
  --env POSTGRES_DB=warehouse_qa docker.io/postgis/postgis:17-3.5
TEST_DATABASE_URL=postgresql://warehouse_test:warehouse_test@127.0.0.1:55439/warehouse_qa node tests/image-pipeline/setup.cjs
TEST_DATABASE_URL=postgresql://warehouse_test:warehouse_test@127.0.0.1:55439/warehouse_qa node tests/image-pipeline/integration.cjs
npm test -- --runInBand
```

The integration harness accepts `IMAGE_PIPELINE_WEBSITE_ROOT` when the website
backend is in a different checkout. It deliberately resets fixture tables, and
rejects remote/non-test database URLs. It checks the actual PostgreSQL migration,
registration, retention, claims, stage independence, retry/backoff, abandoned
leases, both backend HTTP read paths, public visibility, cache versioning,
legacy projection, filename collisions and missing WebP recovery.

Run the dashboard frontend's image/gallery/export tests and production build.
For the website frontend run `node tests/image-pipeline.test.mjs`,
`npm run test:card-links`, `npx tsc --noEmit -p tsconfig.app.json`, and
`npm run build:spa`. For its backend run `npm run test:webp` (includes real Sharp
child-process conversion, bounded downloads, memory/timeout recovery and the
cache invalidation endpoint) plus warehouse filter/cache regression tests.

**Schema application and eventual rollout**

`node scripts/migrateImagePipeline.js` reports a dry run. `--apply` runs only the
targeted SQL files, with short lock/statement timeouts. It hashes every
existing column before/after inside one transaction and rolls back on a mismatch.
It also checks row counts. Reports are stored under `tools/image-pipeline/`.
Do not use Prisma db push against the shared database.

1. Apply the compatible schema; all old scene labels stay READY by default.
   This step is already complete in the shared Supabase database.
2. Deploy the dashboard backend first, letting old label runs finish before the
   replacement starts processing. Registration, reads and stage-based labeling
   become active with the deployment. For a rolling deployment, pause the
   existing label trigger briefly until only the new backend is serving.
3. Deploy the website backend. Its existing maintenance route and CLI now use
   the shared table, and list/detail reads include ordered image objects.
   Existing schedules keep working; no new worker service is needed.
4. Deploy both frontend consumers and rebuild the static website. Dashboard
   list reads stay opt-in via includeImageLabels/includeImages; detail and
   image-label endpoints expose images automatically. Public visibility rules
   remain unchanged and website list cache keys use v8-images.
5. Verify a new submission, an image edit, original-only fallback, and successful
   label/WebP processing. Later static HTML follows the existing build schedule;
   processing completion does not start a site deployment.

If processing needs to stop, pause its existing trigger and keep the compatible
backends deployed. There are no read/write switches to toggle. Keep legacy
fields/projections and all originals; do not restore the old row-existence label
worker after pending rows have been introduced. Queue infrastructure and retiring
compatibility columns remain later work. See the [production deployment notes](image-pipeline-production-rollout.md).

**Processing details**

Claims expire after five minutes. Transient failures retry with exponential
backoff from five minutes, with at most five attempts. Final interrupted attempts
become FAILED; unsupported WebP sources become UNSUPPORTED. Progress/backlog
reports include those states. After correcting an input, an operator can reset
only that stage's attempts/status to retry it; successful labels and other
variants must remain intact. Reattaching the same original reuses its results.

WebP work prioritizes visible warehouses, also covering hidden dashboard stock.
Native decoding stays serial and retains existing Sharp size/memory/time limits.
New objects use a source-URL hash and encoder version, avoiding legacy filename
collisions. Verified legacy objects are reused; unknown historical encoder
settings do not trigger recompression. Missing objects return to PENDING. The
legacy backfill CLI refuses to run once the explicit WebP schema is present.

The manual WebP CLI always uses the shared table. Omit legacy force/start-id/
concurrency overrides: image states and expiring claims govern progress. The Redis run lock is shared with the old job; the image cursor uses a
new namespace so warehouse cursors are never mistaken for image IDs.

**Filling existing WebP rows before deployment**

`node scripts/backfillWebpVariants.js` inventories existing image rows and R2
objects without writing remotely. Add `--apply` to fill the explicit WebP fields,
optionally with `--limit=100`. It reuses the website's bounded native compressor
and the shared database claims. It does not register placeholder rows, run label
models, modify any Warehouse value, or project photosWebp.
This keeps it compatible with the old label service until the backend rollout.

Each run saves progress and a final report under `tools/image-pipeline/`. It
compares all existing Warehouse values and all image fields outside the WebP
stage/source storage keys before and after, and checks every completed result
against its R2 object size. Concurrent normal user edits appear in the comparison
and require review. The run can resume safely using the existing stage statuses.

For diagnosed JPEG scan warnings only, an operator can pass
`--apply --recover-jpeg-warnings=13266,13410`. This claims only the specified
FAILED conversion rows and uses a separately versioned recovery encoder.
Recoverable warnings are allowed; truncated data, decoder errors, other image
formats and invalid metadata are still rejected. Originals stay unchanged.
The normal application compressor remains strict.

`node scripts/verifyWebpBackfill.js YYYY-MM-DD` verifies that day's completed
reports, checks that every READY object exists, decodes a distributed sample of
public WebPs, and checks that their originals remain accessible. Recovery samples
are always included. Coverage distinguishes existing rows from originals awaiting
their first label row. The focused checks are
`node tests/image-pipeline/backfill-webp.cjs` and
`node tests/image-pipeline/backfill-webp-native.cjs`.

**Unused JPEG columns removed — 24 September 2026**

The then-unused JPEG variant fields (`jpegUrl`, `jpegBytes`, `jpegAt`, `jpegVersion`,
`jpegStatus`, `jpegError`) were removed on 24 September and restored for the
[JPEG pilot](jpeg-ppt-pilot.md) on 25 September. Originals, explicit WebP fields, labels,
captions and `Warehouse.media` retain their existing values. Original JPEG files
are still originals; this cleanup does not touch R2 objects.

`node scripts/dropUnusedImageJpeg.js` previews the columns and populated-row count.
`--apply` locks briefly, refuses any populated JPEG metadata or non-default status,
drops only those six fields without CASCADE, and verifies every remaining image
and warehouse value in the same transaction. It rolls back on a mismatch and can
be repeated while the fields are unused. It now refuses to drop them because the
pilot has published JPEG results. Normal pipeline migrations include their schema.

After local test setup, run
`TEST_DATABASE_URL=postgresql://warehouse_test:warehouse_test@127.0.0.1:55439/warehouse_qa node tests/image-pipeline/drop-unused-jpeg.cjs`
to check preservation, refusal when data exists, dependency protection and repeatability.
