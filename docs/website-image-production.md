Website image assessment rollout, 25 September 2026.

This stage stores website suitability and photographic quality in the existing
`labeled_warehouse_images` table, using the Luna prompt from the
[model comparison](./website-image-model-benchmark-2026-09-25.md). Original scene
labels, captions, raw storage and JPEG/WebP variants stay independent. This rollout
does not yet change public gallery selection or PPT exports.

The five result/review fields are `websiteDecision`, `websiteQualityTier`,
`websiteAssessment`, `websiteAssessedAt` and `websiteOverride`. The six execution
fields follow the existing worker convention: `websiteStatus`, `websiteAttempts`,
`websiteError`, `websiteNextAttemptAt`, `websiteClaimToken`, `websiteLeaseUntil`.
Automated work never writes `websiteOverride`; a staff review UI and its
authorization/source-version checks are a later change.

Assessment JSON stores reasons, evidence boxes, view, scene opinion, quality
issues, cover preference, original model opinions and deterministic quality
guards. It includes model/prompt/policy versions and source dimensions, bytes,
ETag and SHA-256. The new scene opinion never overwrites the original label.
Phone/email strings are redacted from free text. Evidence boxes aid review;
they are not guaranteed redaction coordinates.

The tested policy blocks letting/sale/lease signs and readable third-party contact
routes, with REVIEW for ambiguous evidence. It cannot establish who owns a number.
The broader contact and QR rules remain visible for review before public filtering
is enabled. These are model predictions, not guaranteed publication clearances.
Quality guards cap very small sources and the dim detail / blurry obstructed
photos observed in the benchmark. They never clear a contact restriction.

Deployment:

1. Run `node scripts/migrateWebsiteImageApproval.js --apply`. The additive migration
   verifies every pre-existing warehouse and image column using locked before/after
   digests and rolls back on a mismatch. It is repeatable. Do not run production
   `prisma db push`.
2. Backfill before deploying the cron stage:

   ```sh
   node scripts/backfillWebsiteImageApproval.cjs --apply --concurrency=16 \
     --output=/tmp/wareongo-website-backfill-20260925 --background
   ```

   Omit `--apply` for read-only counts; `--limit=100` bounds a pilot. Restarting
   continues pending/retryable/expired rows, preserving READY results. All table
   entries are included, even retained references. Missing current references are
   registered first. Private `status.json`, `progress.jsonl`, `worker.log` and
   `worker.pid` report progress. `/tmp` is ephemeral; the database is authoritative.
3. Run backend QA and local PostgreSQL regressions. CI bootstraps its disposable
   database with `node tests/image-pipeline/setup.cjs`, then runs
   `node tests/image-pipeline/website-approval.cjs`.
4. Push the reviewed backend commit to `main`; the existing workflow gates ECR
   publication on QA. Verify App Runner, then call authenticated
   `POST /api/enrichment/sweep` with `{"dryRun":true}`. Expect
   `stages.websiteImages` with model/version and `configured.websiteImages: true`.
   `node scripts/verifyWebsiteImageDeployment.cjs` performs this check using the
   actual scheduled credential without printing it; `--run` performs real work.
5. Verify a scheduled result in `cron_run_log` and new images moving from PENDING
   to READY. The existing Supabase cron retains its 15-minute schedule, endpoint
   and secret. No new environment flag is required.

The combined sweep runs original marking first (30 seconds, up to 50 images),
then independent proximity and website stages in parallel (45 seconds each),
within the existing 80-second work budget. Website work uses four rolling workers
and at most 12 images. Its run-log name is `sweep_warehouse_website_images`.
`POST /api/image-labels/sweep` remains the separate original marking action.
Both existing upload backends automatically get website PENDING defaults through
their existing image registration inserts.

Claims use five-minute token-fenced leases, five started attempts and retry delays
of 5/10/20/40 minutes. Cancellation before work starts refunds the attempt. Missing,
oversized, animated or unsupported originals become UNSUPPORTED; exhausted failures
remain visible. Neither means approval. Transient database failures retry saving
the same result without paying for another model call.

The local backfill limits concurrency to 16, originals to 20 MiB and dimensions to
40 million pixels. It holds only active images in RAM, creates no R2 objects and
keeps no local originals. Its background process has a 1 GiB V8 heap cap; monitor
RSS too because native buffers are additional. Source/API/database interruptions
can extend the throughput estimate.
The local CLI allows two seconds for each connection address-family attempt;
this avoids premature connection failures on high-latency local routes while
retaining the existing overall download and model deadlines.

For rollback, deploy the previous backend image and retain the additive columns
and completed results. Old writers remain compatible. Do not drop metadata or
reset READY results to pause processing. Public selection, legacy response fields,
static covers, sitemaps and cache invalidation still require the later website
reader rollout described in the [plan](./website-image-approval-plan.md).
