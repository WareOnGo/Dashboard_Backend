# Sol review of uncertain website images

`scripts/reviewWebsiteImagesBatch.cjs` sends only `READY / REVIEW` images through
OpenAI's Batch API using `gpt-5.6-sol`, the existing API key, and the same website
policy/schema as Luna. It uses original images with high detail and medium
reasoning. Luna's assessment is not shown to Sol. The normal cron remains Luna;
this script does not introduce new columns or change scene labeling.

```bash
node scripts/reviewWebsiteImagesBatch.cjs prepare --expected-count=275 --output=tools/website-image-review-batches/2026-09-25-sol-275
node scripts/reviewWebsiteImagesBatch.cjs submit --output=tools/website-image-review-batches/2026-09-25-sol-275
node scripts/reviewWebsiteImagesBatch.cjs watch --apply --background --output=tools/website-image-review-batches/2026-09-25-sol-275
node scripts/reviewWebsiteImagesBatch.cjs status --output=tools/website-image-review-batches/2026-09-25-sol-275
```

Preparation verifies each original against its recorded SHA-256 with at most four
image buffers in memory. The manifest freezes row IDs, input hashes, and the full
prior website assessment. Submission saves the file/batch IDs and will not blindly
resubmit if the API response is lost. Such a submission is recovered by its job ID.

The local detached watcher polls once per minute. It requires this machine to stay
running; the remote batch keeps running if it stops. Restart the same `watch`
command to resume, or run `collect --apply --output=...` once. `collect` without
`--apply` validates and saves results without changing the database. The API may
take up to 24 hours; terminal partial failures are saved, not silently retried as
synchronous requests. Failed/invalid/missing results leave the existing REVIEW.

For provider image-download timeouts, `prepare-retry --expected-count=10
--from=<parent-output> --output=<new-output>` selects only those failed requests,
checks that their rows are unchanged, and embeds their hash-verified originals in
a new Batch input. Run `submit` and `watch --apply` against the new output. This
retains the Batch discount without rerunning successful reviews. The parent
manifest links to retry directories; retry assessments record the parent batch ID.

Before applying a valid response, the script rechecks the original hash. A single
conditional UPDATE requires the same URL, decision, quality, assessment JSON,
timestamp, and no manual override or active claim. Changed rows are skipped.
Source labels, captions, warehouse media, and compression variants are untouched.
The new `websiteAssessment.batchReview` holds the batch/request/response IDs,
usage, source check time, and full prior assessment. Automated reviews never use
the manual `websiteOverride` field. Replay does not duplicate history.

Private snapshots, JSONL input/output, `manifest.json`, `batch.json`, `report.json`
and `watcher.log` stay under the ignored output directory. Do not commit them.
For the 2026-09-25 job, the scope is exactly the 275 reviews existing at preparation;
new future REVIEW rows are not added to this batch.

Validation:

```bash
node tests/image-pipeline/website-batch-review.cjs
TEST_DATABASE_URL=postgresql://warehouse_test:warehouse_test@127.0.0.1:55439/warehouse_qa node tests/image-pipeline/website-batch-review-db.cjs
```

The second command requires the isolated image-pipeline test database, never
production. Official API behavior: [Batch guide](https://developers.openai.com/api/docs/guides/batch).
