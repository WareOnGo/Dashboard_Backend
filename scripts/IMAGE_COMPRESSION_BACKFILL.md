# Image compression metadata backfill

This documents the initial metadata import. Once the explicit WebP schema exists,
this legacy script refuses to apply changes. Use `backfillWebpVariants.js` and the
[current image pipeline notes](../docs/image-pipeline-local-rollout.md) instead.

This extends `labeled_warehouse_images`. `imageUrl` is still the original image,
`description` is still its caption, and the existing label fields retain their
meaning. The new fields hold the matching WebP's URL, R2 key, byte size, object
modification time, and processing status. Existing WebPs retain a null
`compressionVersion` because their encoder settings were not recorded.

Run from the backend checkout:

```bash
node scripts/backfillImageCompression.js --dry-run
node scripts/backfillImageCompression.js --apply
node scripts/backfillImageCompression.js --dry-run
```

The script reads the existing `.env`. It needs `DATABASE_URL` and the five `R2_*`
settings used by uploads. Optional flags are `--env-file=/path/.env`,
`--batch-size=200` (1–500), and `--report=/path/report.json`.

The apply command runs the additive DDL in `sql/imageCompressionMetadata.sql`
and verifies the resulting columns. It does not run `prisma db push`, modify
other tables, write to R2, or call a model. No application deployment or cron
change is needed. The existing generated production Prisma client continues to
read and write its existing columns; new label rows default to compression
status `PENDING` until a later backfill or processor fills them.

Matching uses the original object path and the legacy encoder's
`webp/<original path without extension>.webp` convention. It never pairs arrays
by index or trusts a populated `Warehouse.photosWebp` field. The complete R2
inventory must succeed before any database changes. `READY` means a matching,
nonempty object was listed; it does not claim a full decode/visual inspection.
Missing objects are `PENDING`, unsupported paths are `UNSUPPORTED`, and
conflicting source paths are `FAILED` for inspection.

Each batch commits independently. Re-running recalculates the plan and skips
unchanged metadata, so an interrupted run is resumable. Updates compare prior
metadata and the original URL, protecting concurrent changes; `RUNNING` rows
and results carrying a known `compressionVersion` are skipped. Reports under
`tools/image-compression-backfill/` record progress,
verification, and whether existing label/caption values stayed unchanged.
SIGINT/SIGTERM finish the current database transaction and stop before the next.

Unlabelled images are reported, but **not inserted as placeholder rows**. The
deployed label sweep treats row existence as proof that classification is done.
Nullable classification and queued labeling therefore belong to the later
consumer/worker migration. This backfill preserves that production contract.
Compression and classification of missing outputs, and switching the dashboard,
PPT or website to read the new fields, are separate steps.
