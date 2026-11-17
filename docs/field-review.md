# Warehouse field review

Implementation of the approved v0.6 flow. The frontend and backend both use the `field-review` branch. This feature is independent of the staged warehouse submission review queue.

Availability and Last reviewed now use one linked review item. The [adversarial review](field-review-adversarial-review.md) records the resolved concurrency failure, verification and remaining limits.

## User flow

1. An admin opens the existing warehouse View and selects **Flag for review**. Editable fields gain checkboxes. Each selected field requires a comment.
2. **Review flags** opens the summary and assignee dropdown. New reviews default to the eligible original uploader. The admin can choose another employee. Confirm creates the selected flags together without changing warehouse data.
3. The assigned employee opens **Flagged for review**, using the existing dashboard cards. **Currently flagged** contains active work, including responses awaiting admin. **Previously flagged** contains completed cycles.
4. In **Flagged fields**, the employee directly proposes a correction or selects **No change needed**, adds a verification note, and submits that field. There are no employee Accept, Approve or Reject controls.
5. **All details** renders `WarehouseDetailsModal` itself, with the normal fields, sections, phone controls and media. Switching tabs preserves response drafts and each tab's scroll. The displayed warehouse data remains live data.
6. Admins use **To verify** and **Awaiting employee** in the Flag Review Queue. Ordinary verification applies one field and closes its flag; Request changes returns that field with a required comment.
7. When the live field changed in transit, admins see **Baseline**, **Proposed** and **Current**, with available edit history under Current. No choice is preselected. Keep current, Apply proposed, or Restore baseline closes the flag. Replacing Current requires a reason and confirmation. Another intervening edit cancels that decision and requires a fresh comparison.
8. A warehouse stays active and carries its orange dashboard marker until its final active field closes. Admins can reopen completed flags, preserving earlier responses and decisions.

### Availability and Last reviewed

1. In the existing View, one **Availability & last reviewed** checkbox flags the pair. The two normal View fields keep their existing layout. The confirmation summary includes both values and one review comment.
2. The employee sees the availability selector and review-date calendar in one flagged item. Changing Availability in this editor clears the previous date; the employee enters the date they verified the new answer or leaves it blank if unknown. A correction submits both values, including an explicit null date when cleared. No change needed still requires an explanation and verifies the complete pair.
3. Both values stay staged until admin verification. Changing either live value increments the pair's shared revision and records a complete before/after snapshot. An unrelated field edit does not invalidate this review.
4. A conflict shows the complete pair in **Baseline**, **Proposed** and **Current**, with available history under Current. Each choice applies that complete pair. Replacing Current requires a reason and confirmation; another edit to either value invalidates the displayed comparison, even if it later reverts.
5. Approval writes both values, closes the flag and records the decision in one transaction. Any failure rolls them all back. Normal View/Edit remains available while the flag is active.

## Deployment

The migration is additive and **is not applied automatically on server startup**. It has only been exercised against an isolated local test database during development.

Before enabling this code in a deployed environment:

```sh
npx prisma generate
node scripts/migrateFieldReview.js
node scripts/migrateFieldReview.js --apply
```

The first migration command is a dry run. The second explicitly creates five review/history tables, indexes, two edit-tracking triggers and their trigger function. It enables row-level security, revokes direct API/public access, and verifies that the backend database role retains access and can bypass RLS. Security verification happens inside the DDL transaction: a failed verification rolls back that migration's tables, hooks and permission changes. Run it with the intended environment's database configuration and DDL permissions. It uses a transaction and a 5-second lock timeout; retry during a quieter period if an existing warehouse write holds the table lock. Apply this migration before exposing the frontend feature. Prisma schema push alone does not install the partial unique indexes, tracking triggers or database access protections.

Existing warehouses are not rewritten. Versions start when the triggers are installed. Field history combines new snapshots with earlier available warehouse audit summaries, without duplicating summaries of already tracked writes. New snapshots retain their field revision so equal timestamps cannot scramble write order. Old handover and availability summaries are explicitly labeled as individual recorded parts. The UI does not invent missing actors, values or times. Install the current migration before enabling the linked review API so both availability columns use the `availabilityReview` tracker.

To roll back the application, deploy the previous application version and leave the additive tables/history in place. Do not delete review history or disable tracking while review writes are still enabled.

## Data and authorization

- `WarehouseFieldReview`: warehouse, saved assignee, resolved uploader ID when available, creator, timestamps and revision.
- `WarehouseFieldFlag`: stable field key, label snapshot, comment author, original flag value, current attempt, baseline/version, proposal, explanation, state and decision.
- `WarehouseFieldReviewEvent`: append-only action records, preceding responses/decisions, actor and idempotency key.
- `WarehouseFieldVersion`: per-field revision, incremented by database triggers. A change followed by a revert still invalidates an older comparison.
- `WarehouseFieldEdit`: before/after field values, field revision, time and available actor/source. Ordinary dashboard edits set transaction-local actor information.

A partial unique index enforces one active cycle per warehouse and one active flag per warehouse/field. Approval locks the warehouse and its detail row, rechecks the field/review versions and permission, and writes the selected value, flag closure and event in one transaction. Unrelated field changes do not cause a conflict. Duplicate request keys cannot repeat an action or be reused for another field.

The existing JWT and warehouse permission gates apply. The service also checks current roster eligibility on every operation. Only admins can create, assign, verify, return or reopen. Only the current assignee with Edit access to this warehouse can respond. Assignment options require that same access; the original uploader is the default only when eligible. If an existing assignee loses access, their ownership/history is retained and the admin is prompted to restore access or reassign. Other employees see the dashboard indicator but cannot open another employee's review. Assignment does not grant additional access.

Protected phone snapshots, activity and edit history are masked. Revealing them requires an explanation and records an access event. An existing alternate contact remains visibly masked in All details rather than looking missing. Database API roles cannot directly read the raw snapshots. Deleted warehouses retain review history, remain searchable by WHID, and cannot be recreated through review actions.

## API

All responses use `{ success: true, data }`; failures use `{ success: false, error: { code, message } }`.

| Endpoint under `/api/field-reviews` | Purpose |
| --- | --- |
| `GET /setup/:warehouseId` | Flag registry, current values, eligible assignees and default uploader |
| `POST /` | Atomically create fields after summary confirmation |
| `GET /` | Role-scoped, paginated queues and warehouse counts |
| `GET /summaries?ids=...` | One request for visible dashboard card markers |
| `GET /:id` | Review, field comparisons, normal warehouse data and recent activity |
| `GET /:id/events?cursor=...` | Earlier review activity, 50 records at a time |
| `PATCH /:id/assignee` | Change active review ownership |
| `POST /:id/flags/:flagId/response` | Stage correction or no-change response |
| `POST /:id/flags/:flagId/decision` | Verify with PROPOSED, CURRENT or BASELINE |
| `POST /:id/flags/:flagId/return` | Request changes with a comment |
| `POST /:id/flags/:flagId/reopen` | Reopen a completed field |
| `GET /:id/flags/:flagId/history` | Latest 100 available edits for that field |
| `POST /:id/flags/:flagId/reveal` | Audited protected-value reveal |

Mutations carry a UUID `requestId` and expected flag/review revision. Responses also carry the employee's checked `baselineVersion`; decisions carry the admin's reviewed `currentVersion`. A 409 requires refreshing the comparison/status. The frontend retains drafts and reuses operation keys for retries after uncertain transport failures.

The `availabilityReview` field replaces the two individual availability keys in the unreleased registry. Its correction value must include both properties, for example `{ "availability": "No", "availabilityLastReviewedOn": "2026-11-16" }`. A missing property, invalid/future date, or a date with no Availability answer is rejected. An explicit null date is allowed. A stale employee response returns `BASELINE_CHANGED`; a stale admin choice returns `CURRENT_CHANGED` if either member of the pair changed.

## V1 decisions and limits

- The existing warehouse uploader is a freeform string, not a roster foreign key. New reviews resolve a unique eligible email or employee ID first, then a unique exact name, and save the resulting uploader ID. Ambiguous or unavailable uploaders require an explicit assignee. Existing cycles retain their saved assignee.
- Comments, verification notes and replacement reasons are limited to 500 characters. Both correction and no-change responses require a note.
- Drafts survive tab switches and closing/reopening previews within the browser session. A changed live revision clears a saved admin choice, reason and confirmation on refresh/reopen; employee input keeps its original baseline and requires explicit reconfirmation. Flag creation setup and summaries reset on identity/role changes, and late results from the old session are ignored. Drafts are not persisted across reloads or devices. Protected drafts are never written to browser storage.
- Former assignees retain authorship in history but lose access after reassignment. Admins retain access.
- Current field constraints are validated again before applying a proposal or baseline. Legacy values may be verified unchanged. The review API requires actual JSON numbers for numeric fields. Google Maps URL edits follow the current warehouse form's nonempty-text validation and change only that URL; pin resolution is deferred in the existing form as well. Coordinate corrections update derived micro-market tags using polygons fetched before acquiring warehouse locks.
- Review inputs reuse the current warehouse form's controls and options, including dropdowns, calendars, switches, ordered area inputs, phones, measurements, ventilation and washrooms. String-backed toggles retain their string type; legacy Yes/No values compare consistently with true/false. Compound handover timing is one logical field and follows the form's optional/unconfirmed timing rules: a fixed date may be cleared and an unchosen lead unit stays empty. A Handover decision applies the selected timing type and its displayed values; saved values for the other type are preserved from the current locked row, including newer ordinary edits. Final snapshots record the actual result. Media, generated fields and visibility controls cannot be flagged.
- No bulk approval, external notifications, employee withdrawal or admin cancellation of mistaken flags in V1. Queues and markers are the notification surfaces.
- Dashboard markers refresh on review actions and page loads. Queue Refresh reloads the server state. Cross-browser live push and automatic polling are not included.

## Verification

Backend tests cover staged data isolation, all conflict choices, no-change verification, concurrent admins, audit failure rollback, retries, returns, reassignment, revoked access, protected values, deleted warehouses, field histories and location dependencies. Route tests exercise real authentication/capability middleware and strict request validation.

```sh
npm test -- --runInBand tests/routes/fieldReviews.test.js
TEST_DATABASE_URL=postgresql://warehouse_test:warehouse_test@127.0.0.1:55445/warehouse_qa npm run test:integration -- --runTestsByPath tests/integration/fieldReview.test.js
```

The integration URL guard permits only the explicitly disposable local `warehouse_qa` database with test credentials. Each run creates and drops a random schema. The fixture preserves required columns, native calendar-date columns, actual scalar defaults and the relevant foreign keys; it does not reproduce PostGIS/vector infrastructure or every deployed database trigger. Never use a deployed database for these tests.

Frontend component tests and the Chrome desktop/mobile workflow are described in `Frontend_Repository/docs/field-review.md`.
