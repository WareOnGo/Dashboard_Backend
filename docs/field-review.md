# Warehouse field review

Implementation of the approved v0.6 flow. This feature is independent of the staged warehouse submission review queue.

Availability and Last reviewed now use one linked review item. The [adversarial review](field-review-adversarial-review.md) records the resolved concurrency failure, verification and remaining limits.

Media review (local implementation, 19 November 2026): reviewers can flag only the complete media section from the existing View. It covers images, videos and documents, including missing files. Individual files cannot be flagged. This supersedes the earlier V1 exclusion of media.

## User flow

1. A reviewer opens the existing warehouse View and selects **Flag for review**. Editable fields gain checkboxes. Each selected field requires a comment.
2. **Review flags** opens the summary and assignee dropdown. New reviews default to the eligible original uploader. The reviewer can choose another employee. Confirm creates the selected flags together without changing warehouse data.
3. The assigned employee opens **Flagged for review**, using the existing dashboard cards. **Currently flagged** contains active work, including responses awaiting reviewer. **Previously flagged** contains completed cycles.
4. In **Flagged fields**, the employee directly proposes a correction or selects **No change needed**, adds a verification note, and submits that field. There are no employee Accept, Approve or Reject controls.
5. **All details** renders `WarehouseDetailsModal` itself, with the normal fields, sections, phone controls and media. Switching tabs preserves response drafts and each tab's scroll. The displayed warehouse data remains live data.
6. Reviewers use **To verify** and **Awaiting employee** in the Flag Review Queue. Ordinary verification applies one field and closes its flag; Request changes returns that field with a required comment.
7. When the live field changed in transit, reviewers see **Baseline**, **Proposed** and **Current**, with available edit history under Current. No choice is preselected. Keep current, Apply proposed, or Restore baseline closes the flag. Replacing Current requires a reason and confirmation. Another intervening edit cancels that decision and requires a fresh comparison.
8. A warehouse stays active and carries its orange dashboard marker until its final active field closes. Reviewers can reopen completed flags, preserving earlier responses and decisions.

### Availability and Last reviewed

1. In the existing View, one **Availability & last reviewed** checkbox flags the pair. The two normal View fields keep their existing layout. The confirmation summary includes both values and one review comment.
2. The employee sees the availability selector and review-date calendar in one flagged item. Changing Availability in this editor clears the previous date; the employee enters the date they verified the new answer or leaves it blank if unknown. A correction submits both values, including an explicit null date when cleared. No change needed still requires an explanation and verifies the complete pair.
3. Both values stay staged until reviewer verification. Changing either live value increments the pair's shared revision and records a complete before/after snapshot. An unrelated field edit does not invalidate this review.
4. A conflict shows the complete pair in **Baseline**, **Proposed** and **Current**, with available history under Current. Each choice applies that complete pair. Replacing Current requires a reason and confirmation; another edit to either value invalidates the displayed comparison, even if it later reverts.
5. Approval writes both values, closes the flag and records the decision in one transaction. Any failure rolls them all back. Normal View/Edit remains available while the flag is active.

## Media review

### Reviewer raises the flag

1. Open the existing warehouse View and select **Flag for review**. Select the single **Media section** checkbox and enter a comment, such as “Add photos of the loading docks” or “Replace the outdated site photos.” This works when the gallery is empty. Files keep their usual preview controls; there are no individual-file checkboxes.
2. Select **Review flags**. The summary shows the gallery previews/links, the comment and the assignee dropdown, defaulting to the eligible uploader. Confirm to create one section flag. Creation captures the live gallery at confirmation and does not change it.

### Employee responds

1. Open the assigned warehouse in **Flagged for review**, then its **Media section** item in **Flagged fields**. Use the shared warehouse upload control to add missing files, remove files from the proposed gallery, or replace files by removing and uploading. Even an entirely empty gallery can receive new uploads.
2. Add the required verification note and submit. **No change needed** is also available with a required explanation. Uploads and edits remain staged until reviewer approval; submission is disabled while uploads run. **All details** shows the real, familiar View and the live gallery; switching tabs retains the response draft.
3. If someone changes the gallery before submission, the employee must refresh and reconfirm the draft against the latest gallery. Ordinary View/Edit continues to work throughout.

### Reviewer verifies

1. Open the response in the Flag Review Queue. Image thumbnails, video controls and document links show the proposed and current gallery. Approve the correction or verify a no-change response; request changes if needed.
2. If the live gallery changed after submission, compare **Baseline**, **Proposed** and **Current**. Current has an expandable edit history when available. Choose **Keep current**, **Apply proposed** or **Restore baseline**; each choice applies to the complete gallery shown. Replacing Current requires a reason and explicit confirmation. A later edit invalidates the comparison and requires another review.
3. Verification atomically writes both `media` and legacy `photos`, closes the flag and records the decision. Image-pipeline registration runs after commit, as with normal media edits. The section can be cancelled or reopened through the existing workflow.

### Edge cases

- **Someone deletes a photo:** the section flag remains open, including if all files are removed. Before submission this makes the employee draft stale; after submission it triggers the three-gallery comparison. The flag never points to a missing individual file. Applying an older proposal or baseline can restore removed references, so the reviewer must inspect the complete chosen gallery and confirm replacement.
- **The request is to add photos:** flag the section and specify the missing coverage in the comment. No placeholder image or existing file is required.
- **Files are added, replaced, reordered, or changed and then restored:** every gallery change advances the shared `media` revision. An unrelated data-field edit does not invalidate the media response. Earlier snapshots and the edit history remain available.
- **Older media history:** earlier `media` and `photos` audit entries are shown as recorded fields, preserving available values or bounded summaries without claiming they are complete gallery snapshots.
- **Files are removed through approval:** the warehouse references are detached; review decisions do not physically delete storage objects or historical evidence. Historical previews depend on those objects remaining available in storage.

The existing review tables are reused with one fixed key, `media`; individual-file keys are rejected. Proposals accept only current/original files, a previously submitted proposal for the same flag, or uploads issued for that flag and employee, in the proper category. The scoped upload endpoint requires an assigned open media flag and View access; it does not grant ordinary Edit access. Review uploads use a signed create-only PUT: an issued URL cannot overwrite an existing object. The browser sends the signed headers returned by the service. Activity retains the server-issued object key and public URL, never the presigned upload URL. Before submission and before applying a new upload, the service checks its existence, MIME metadata and nonzero size below 50 MB. A missing/invalid object prevents the response or approval; a storage outage returns a retryable error without closing the flag. These reads run outside warehouse write locks, in batches of at most five with a ten-second deadline. Assignment, flag and live revisions are checked again inside the write transaction. Uploaded objects stay unattached until approval; abandoned uploads follow the existing storage retention/cleanup policy.

The media editor permits up to 200 files per proposed gallery and uses the shared upload control's 50 MB limit per file. System metadata, visibility controls and voice notes remain outside this gallery.

## Deployment

The migration is additive and **is not applied automatically on server startup**. Production installation was applied and verified on 18 November 2026 (IST): all five tables, both tracking triggers, the active-review uniqueness indexes, RLS and backend access were verified, with direct public/API table access revoked.

Before enabling this code in a deployed environment:

```sh
npx prisma generate
node scripts/migrateFieldReview.js
node scripts/migrateFieldReview.js --apply
```

The first migration command is a dry run. The second explicitly creates five review/history tables, indexes, two edit-tracking triggers and their trigger function. It enables row-level security, revokes direct API/public access, and verifies that the backend database role retains access and can bypass RLS. Security verification happens inside the DDL transaction: a failed verification rolls back that migration's tables, hooks and permission changes. Run it with the intended environment's database configuration and DDL permissions. It uses a transaction and a 5-second lock timeout; retry during a quieter period if an existing warehouse write holds the table lock. Apply this migration before exposing the frontend feature. Prisma schema push alone does not install the partial unique indexes, tracking triggers or database access protections.

Existing warehouses are not rewritten. Versions start when the triggers are installed. Field history combines new snapshots with earlier available warehouse audit summaries, without duplicating summaries of already tracked writes. New snapshots retain their field revision so equal timestamps cannot scramble write order. Old handover and availability summaries are explicitly labeled as individual recorded parts. The UI does not invent missing actors, values or times. Install the current migration before enabling the linked review API so both availability columns use the `availabilityReview` tracker.

For media support, re-run the current `migrateFieldReview.js --apply` before deploying the media UI/API. It adds the `field_review_media` normalization helper and replaces the existing tracking function/trigger to track one complete-gallery revision; it creates no additional table and does not rewrite existing warehouse media. Apply in the intended deployment only through its normal release process. These media changes are local and have not been deployed. Media history starts with installation; earlier gallery changes are not invented.

Release order: apply and verify the migration, deploy the backend, then deploy the frontend. The storage token needs object metadata (HEAD) access, and the bucket must allow `Content-Type` and `If-None-Match` for PUTs from the dashboard origin. Read-only preflight and metadata checks passed against the configured storage endpoint on 19 November 2026; no storage objects or settings were changed. Create-only behavior follows [Cloudflare’s conditional-write contract](https://developers.cloudflare.com/r2/api/s3/conditional-operations/). Run the normal deployed upload/approval smoke test after release.

To roll back the application, deploy the previous application version and leave the additive tables/history in place. Do not delete review history or disable tracking while review writes are still enabled.

## Data and authorization

- `WarehouseFieldReview`: warehouse, saved assignee, resolved uploader ID when available, creator, timestamps and revision.
- `WarehouseFieldFlag`: stable field key, label snapshot, comment author, original flag value, current attempt, baseline/version, proposal, explanation, state and decision.
- `WarehouseFieldReviewEvent`: append-only action records, preceding responses/decisions, actor and idempotency key.
- `WarehouseFieldVersion`: per-field revision, incremented by database triggers. A change followed by a revert still invalidates an older comparison.
- `WarehouseFieldEdit`: before/after field values, field revision, time and available actor/source. Ordinary dashboard edits set transaction-local actor information.

A partial unique index enforces one active cycle per warehouse and one active flag per warehouse/field. Approval locks the warehouse and its detail row, rechecks the field/review versions and permission, and writes the selected value, flag closure and event in one transaction. Unrelated field changes do not cause a conflict. Duplicate request keys cannot repeat an action or be reused for another field.

Mutation responses are assembled inside that same transaction, using its authorized actor. If preparing the response fails, the write rolls back. Idempotent retries also read their response inside the transaction; there is no separate post-commit permission read that could report failure after a successful write.

The existing JWT and warehouse permission gates apply. The `REVIEW` capability (`reviewerAccess`) permits creating flags, verifying responses, requesting changes, reopening and reassignment within the caller’s warehouse View scope. Admins inherit this capability. Reviewer access alone does not grant Dashboard or warehouse View access. The service also checks current roster eligibility on every operation. Only reviewers can create, assign, verify, return or reopen. The current assignee can submit proposals for open flagged fields without warehouse Edit permission. Assignment options require an active, unique employee identity with View access to the warehouse; the original uploader is the default only when eligible. If an existing assignee loses account or View access, their ownership/history is retained; a reviewer can reassign the review, or an admin can restore the employee’s access. Other employees see the dashboard indicator but cannot open another employee's review.

Assignment authorizes only responses to that review’s fields in `NEEDS_RESPONSE` or `CHANGES_REQUESTED`. Closed fields reject responses even if another field is still open. Closing all flags sets `canRespond` to false; reopening restores response permission to the current assignee. Reassignment transfers that permission immediately. Saved warehouse Edit grants are never changed, so no cleanup job is needed and ordinary warehouse editing remains governed by the employee’s existing permissions. Proposals stay staged until verification.

Verification requires Reviewer and warehouse View access; it does not require warehouse Edit access. An employee who also has Reviewer access may respond when assigned and may verify their own response. The setup route explicitly reads fresh reviewer grants, so permission changes made on another API instance do not wait for the local capability cache to expire.

Protected phone snapshots, activity and edit history are masked. Revealing them requires an explanation and records an access event. An existing alternate contact remains visibly masked in All details rather than looking missing. Database API roles cannot directly read the raw snapshots. Deleted warehouses retain review history, remain searchable by WHID, and cannot be recreated through review actions.

Any employee with View access to a warehouse can identify its active flagged fields and read the original review note for each field in normal View. Summaries include `activeFieldKeys` and `activeFields: [{ fieldKey, comment }]` alongside the count. Proposals, response explanations, assignees, history and protected values are not included. Unassigned employees still receive `reviewId: null` and `canOpen: false`. Fields awaiting verification remain active; verified fields disappear from the summary and reopened fields return.

`GET /api/warehouses?includeFieldReviews=true` (and the optional single-warehouse equivalent) embeds this same scoped projection as `fieldReviewSummary` in each row. Unflagged rows receive an explicit empty summary. Review lookups are batched in groups of at most 100 warehouse IDs; full-table consumers pay no extra query or payload unless they opt in. A failed review lookup fails the requested response instead of reporting an unknown review status as unflagged. Fresh access revocations return 403 through the shared warehouse error handler.

## API

The stored `AWAITING_ADMIN` status is retained for compatibility; the interface labels it **Awaiting reviewer**. This permission change requires no database migration.

All responses use `{ success: true, data }`; failures use `{ success: false, error: { code, message } }`.

| Endpoint under `/api/field-reviews` | Purpose |
| --- | --- |
| `GET /setup/:warehouseId` | Flag registry, current values, eligible assignees and default uploader |
| `POST /` | Atomically create fields after summary confirmation |
| `GET /` | Role-scoped, paginated queues and warehouse counts |
| `GET /summaries?ids=...` | Counts, active field keys and their original review notes within the caller’s View scope; used for refreshes and unbundled callers |
| `GET /:id` | Review, field comparisons, normal warehouse data and recent activity |
| `GET /:id/events?cursor=...` | Earlier review activity, 50 records at a time |
| `PATCH /:id/assignee` | Change active review ownership |
| `POST /:id/flags/:flagId/response` | Stage correction or no-change response |
| `POST /:id/flags/:flagId/decision` | Verify with PROPOSED, CURRENT or BASELINE |
| `POST /:id/flags/:flagId/return` | Request changes with a comment |
| `POST /:id/flags/:flagId/reopen` | Reopen a completed field |
| `POST /:id/flags/:flagId/cancel` | Cancel an active flag with a required reason; warehouse data stays unchanged |
| `GET /:id/flags/:flagId/history` | Latest 100 available edits for that field |
| `POST /:id/flags/:flagId/upload` | Scoped presigned upload for an assigned open media flag; no live gallery write |
| `POST /:id/flags/:flagId/reveal` | Audited protected-value reveal |

Mutations carry a UUID `requestId` and expected flag/review revision. Responses also carry the employee's checked `baselineVersion`; decisions carry the reviewer's reviewed `currentVersion`. A 409 requires refreshing the comparison/status. The frontend retains drafts and reuses operation keys for retries after uncertain transport failures.

The `availabilityReview` field replaces the two individual availability keys in the unreleased registry. Its correction value must include both properties, for example `{ "availability": "No", "availabilityLastReviewedOn": "2026-11-16" }`. A missing property, invalid/future date, or a date with no Availability answer is rejected. An explicit null date is allowed. A stale employee response returns `BASELINE_CHANGED`; a stale reviewer choice returns `CURRENT_CHANGED` if either member of the pair changed.

## V1 decisions and limits

- The existing warehouse uploader is a freeform string, not a roster foreign key. New reviews resolve a unique eligible email or employee ID first, then a unique exact name, and save the resulting uploader ID. Ambiguous or unavailable uploaders require an explicit assignee. Existing cycles retain their saved assignee.
- Comments, verification notes and replacement reasons are limited to 500 characters. Both correction and no-change responses require a note.
- Drafts survive tab switches and closing/reopening previews within the browser session. A changed live revision clears a saved reviewer choice, reason and confirmation on refresh/reopen; employee input keeps its original baseline and requires explicit reconfirmation. Flag creation setup and summaries reset on identity/role changes, and late results from the old session are ignored. Drafts are not persisted across reloads or devices. Protected drafts are never written to browser storage.
- Former assignees retain authorship in history but lose access after reassignment. Reviewers retain access.
- Current field constraints are validated again before applying a proposal or baseline. Legacy values may be verified unchanged. The review API requires actual JSON numbers for numeric fields. Google Maps URL edits follow the current warehouse form's nonempty-text validation and change only that URL; pin resolution is deferred in the existing form as well. Coordinate corrections update derived micro-market tags using polygons fetched before acquiring warehouse locks.
- Review inputs reuse the current warehouse form's controls and options, including dropdowns, calendars, switches, ordered area inputs, phones, measurements, ventilation, washrooms and media uploads. String-backed toggles retain their string type; legacy Yes/No values compare consistently with true/false. Compound handover timing is one logical field and follows the form's current required-field policy; an unchosen lead unit stays empty. Handover proposals and decisions apply the selected timing type and its displayed values; saved values for the other type are preserved from the current locked row, including newer ordinary edits. Switching timing types therefore does not count as clearing the inactive values. Final snapshots record the actual result. Generated fields and visibility controls cannot be flagged.
- No bulk approval, external notifications or employee withdrawal in V1. Reviewers may cancel a mistaken flag with a reason. Queues and markers are the notification surfaces.
- Dashboard markers refresh on review actions and page loads. Queue Refresh reloads the server state. Cross-browser live push and automatic polling are not included.

## Verification

Backend tests cover staged data isolation, all conflict choices, no-change verification, concurrent reviewers, audit and response-preparation rollback, retries, returns, assignment without Edit access, closure/reopening/reassignment of response permission, revoked account/View access, reviewer/employee permission separation, self-verification, protected values, deleted warehouses, field histories, handover mode switching and location dependencies. Route tests exercise real authentication/capability middleware, denial of ordinary warehouse edits for read-only assignees, cross-instance role changes with a populated cache and strict request validation.

```sh
npm test -- --runInBand tests/routes/fieldReviews.test.js
TEST_DATABASE_URL=postgresql://warehouse_test:warehouse_test@127.0.0.1:55445/warehouse_qa npm run test:integration -- --runTestsByPath tests/integration/fieldReview.test.js
```

The integration URL guard permits only the explicitly disposable local `warehouse_qa` database with test credentials. Each run creates and drops a random schema. The fixture preserves required columns, native calendar-date columns, actual scalar defaults and the relevant foreign keys; it does not reproduce PostGIS/vector infrastructure or every deployed database trigger. Never use a deployed database for these tests.

Frontend component tests and the Chrome desktop/mobile workflow are described in `Frontend_Repository/docs/field-review.md`.
