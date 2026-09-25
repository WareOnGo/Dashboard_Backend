# JPEG variants and backfill

Updated 25 September 2026. The existing `labeled_warehouse_images` table holds six
JPEG fields: `jpegUrl` (the real R2/public URL), `jpegBytes`, `jpegAt`,
`jpegVersion`, `jpegStatus` and `jpegError`. Original URLs/files, WebPs, labels,
captions and `Warehouse.media` remain intact. No extra table or processing flags
are needed. JPEG work is currently a manual backfill, not a scheduled worker.

## Measured PPT sizes

The pilot compressed 41 photographs from warehouses 2737, 2731, 2726 and 2722.
Both JPEG presets use quality 82, progressive encoding, 4:2:0 chroma, automatic
orientation, white alpha flattening and no enlargement. The second comparison
was encoded directly from originals, not from the first JPEGs.

| Four-option V3 deck | Originals | JPEG, 1920px | JPEG, 1280px |
| --- | ---: | ---: | ---: |
| Six photographs per option | 28.81 MB | 8.80 MB | 6.32 MB |
| All 41 photographs | 48.31 MB | 13.07 MB | 9.04 MB |

Both combined decks retain the same map, slide order, selections and branding.
Archive checks verified every selected photo and all unchanged slide/relationship
parts. The 24-photo JPEG decks were rendered in LibreOffice at 1080p for visual
comparison. This is not a Microsoft PowerPoint/platform compatibility test.
The earlier individual-warehouse comparisons omitted maps in both versions
because the existing single-point map request returned HTTP 422.

The agreed backfill preset is **1280px maximum edge, quality 82 for photographs**.
Documents/drawings keep a **1920px** maximum edge to retain more fine detail.
The application now uses these JPEGs when **Generate compressed PPT (beta)**
is checked. This replaces the earlier WebP PPT option.
See [compressed PPT export](webp-ppt-export.md) for fallback and verification details.

## Completed backfill

Verified at **25 September 2026, 06:02 UTC** (11:32 IST), including five images
uploaded while the original run was in progress:

- **16,144 / 16,144 referenced images READY**, with no unfinished rows.
- **5,535 original URLs reused**; **10,609 encoded JPEG variants**.
- Referenced originals total **11.52 GB**; the JPEG selections total **2.27 GB**,
  of which **1.64 GB** is new JPEG storage. Originals were retained.
- Fresh R2 inventory found no missing/changed original objects, no missing JPEG
  objects and no byte-size mismatches. Twenty-eight samples were downloaded and
  decoded again. Transient network/database failures were retried successfully.
- Peak main-process RSS was **251 MiB**; the highest individual decoder peak was
  **135 MiB**. No memory-limit failures occurred. All temporary image buffers were
  cleared when their runs ended.

The final private report is
`tools/image-pipeline/2026-09-25T06-02-06-142Z-jpeg-verification.json`.
Production labeling/WebP processing continued during the run; long-lived whole
table snapshots therefore include other changes. Each successful JPEG publication
independently verified unchanged non-JPEG fields atomically. This job issues no
Warehouse updates and does not delete or overwrite original/WebP objects.

## Two-pass backfill

1. List currently referenced image rows and their R2 source objects. A row shared
   by several warehouses is processed once. Unreferenced rows are not processed.
2. Check sources up to 200 KiB. Reuse their exact original URL when the decoded
   format is JPEG, the URL has a JPEG extension, orientation needs no correction,
   colour space is sRGB/greyscale, and both dimensions fit the applicable limit.
   Fully decode candidates before publishing `READY`; a filename alone is not proof.
3. Finish the entire reuse pass before uploading anything. Stream the remaining
   sources to bounded temporary files, encode from originals, then upload under
   a versioned `jpeg/images/` key based on the URL and source-content hashes.
   If encoding enlarges an otherwise suitable JPEG, reuse the original instead.
4. Fetch every new variant through its public URL and compare its hash before
   publishing its URL and byte size. The conditional upload never overwrites an
   object. The database update rejects changed JPEG results or removed references
   and rolls back if any non-JPEG field unexpectedly changes.

The transfer pool defaults to eight and permits at most sixteen end-to-end tasks;
only two isolated decoders run at once. Downloads
are capped at 20 MiB each; decoders reject images over 16 million pixels, have a
30-second lifetime and a monitored 256 MiB RSS limit each. Sharp uses one native
thread per decoder and no cache. The parent stops under memory pressure. Temporary
files are cleared after every item in both passes; the catalogue is never retained
in RAM or buffered in full on disk. The same command skips completed current
variants when rerun. Errors remain explicit rather than being marked ready.
Even at sixteen tasks, source-file buffering cannot exceed 320 MiB. The live
backfill uses sixteen after observing ample host memory and low decoder RSS.

```sh
node scripts/migrateImageJpeg.js --apply
node scripts/inventoryJpegVariants.js
node scripts/backfillJpegVariants.js --inventory=tools/image-pipeline/jpeg-backfill-1280-inventory.json
flock -n /tmp/wareongo-jpeg-backfill.lock node --max-old-space-size=256 scripts/backfillJpegVariants.js --inventory=tools/image-pipeline/jpeg-backfill-1280-inventory.json --apply --workers=16
node scripts/verifyJpegBackfill.js tools/image-pipeline/jpeg-backfill-1280-inventory.json
```

The migration is additive and was already applied. Only `backfillJpegVariants.js`
with `--apply` writes image results/storage; verification is read-only. Inventory and per-run reports under `tools/image-pipeline/`
are private local operational artifacts and should not be committed. Each run
stores previous JPEG metadata, an append-only result journal and an atomic
progress report. Previous pilot objects remain available; this job deletes no R2
objects. Original-reuse rows use version `jpeg-original-reuse-v1`; encoded versions
are `jpeg-1280-q82-progressive-420-v1` or `jpeg-1920-q82-progressive-420-v1`.
Ready updates are grouped into batches of up to eight rows to reduce round trips;
the existing two-connection Prisma pool is retained.
To include newer uploads, create a fresh inventory with `--output=path` and pass
that path to the backfill. Inventory files refuse overwrites so an earlier
preservation baseline is not lost. Whole-table digest comparisons span concurrent
production activity; each successful JPEG publication separately checks that its
non-JPEG fields stay unchanged in the same atomic database statement.

## Local verification

Use only the isolated Podman test database, never the production database:

```sh
TEST_DATABASE_URL=postgresql://warehouse_test:warehouse_test@127.0.0.1:55439/warehouse_qa node tests/image-pipeline/jpeg-backfill.cjs
```

Tests cover passthrough eligibility, safe publication of the same original URL,
preservation of all existing values, stale-writer/reference rejection, rollback
when a trigger changes a protected field, native JPEG orientation/resize and
bounded worker concurrency. The earlier pilot/migration/cleanup and shared image
pipeline suites also pass.
