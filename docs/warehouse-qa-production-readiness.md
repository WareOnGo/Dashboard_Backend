# Manual warehouse QA readiness — 25 November 2026

**Verdict: the manual QA implementation is ready to push for review and a controlled production rollout. The identified functional gaps are fixed and the local release checks pass.** This report concerns admin-triggered QA and employee handoff. Hourly scheduling and automated alerts are deferred in [future automation](warehouse-qa-future-automation.md); neither is a prerequisite for this release.

No production deployment, migration, configuration change or employee task was created during this audit. At audit completion, the changes had not yet been committed or pushed. The local dashboard used production source reads with isolated local QA storage and `AI_QA_HANDOFF=staged`. Native employee handoff was separately verified against disposable synthetic PostgreSQL data. The deployment steps below remain separate from this local verification.

## Findings fixed in this audit

| Finding | Resolution |
| --- | --- |
| Manual batches depended on idle background CPU; a refresh lost the UI's active job. | The admin UI advances durable work through authenticated `POST /api/ai-qa/runs/:id/process`. Reopening the page discovers unfinished runs before completed history. Network failure offers Resume QA against the same saved run. Processing never enqueues a duplicate batch. Database tests simulate a new service instance with no background timer or cron. |
| Reload after another reviewer changed an assignment retained the old, locked assignee. | Reload restores the server's current assignee and fresh version together. A frontend regression exercises the conflict and reload. |
| Failed evaluations could be overlooked in the combined inbox. | The failure/policy warning uses returned evaluation counts, including the combined inbox. Failed work cannot be treated as a clean review. |
| Five full-suite UI checks exceeded their time limits under coverage. | Scoped queries avoid repeatedly searching the entire dashboard/modal; the complete new-warehouse creation journey has its own 60-second budget. Assertions and global coverage thresholds remain intact. The five focused checks and the final full suite pass. |

## Manual integration and safety

- Only fresh admin authorization can access AI reviews or advance a manual batch. Employee accounts cannot see the AI stage, and the optional cron credential cannot approve flags or read review data.
- The current policy covers PEB text and cross-field checks. RCC/BTS listings are excluded. Snapshots sent to the model exclude contacts, addresses and media. The SOP, engine, output schema and model identity are pinned; changed execution contracts fail explicitly and need a new evaluation.
- Admins review purple AI suggestions, add yellow human flags and notes, then confirm individual warehouse assignments using the existing view, card, confirmation and employee review components. AI/Human source attribution and notes survive handoff.
- Confirmation rechecks source values, dependencies, revisions and eligibility under warehouse locks. Stale evidence preserves decisions/audit and queues a fresh evaluation. Missing warehouses remain readable and unassignable without hiding surviving cards.
- Real handoff uses `AI_QA_HANDOFF=field-review` with the same database/schema and Prisma transaction as normal field reviews. QA decisions, employee tasks and both audits commit together or all roll back. Existing active fields, assignees and manual comments are protected.
- QA approval does not change warehouse values. Employee corrections still require the ordinary verification flow. Unknown measurement units stay unknown until explicitly supplied; power is never silently changed to kVA.
- Writes are idempotent and versioned. Tests cover lost responses, concurrent confirmation, audit failures, revoked access, changed assignees and duplicate manual fields. Audit metadata records `runBy: Raghav` and the authenticated actor, scoped by warehouse.

Closing the page preserves work. On hosts that suspend background CPU, unfinished work resumes when an admin returns. Unattended completion with all clients closed belongs to the later automation phase.

## Verification

| Check | Result |
| --- | --- |
| Full backend `npm run test:ci`, Node 22 | 102 suites; 2,217 passed; coverage thresholds passed |
| Full PostgreSQL integration suite | 15 suites; 346 passed |
| Full frontend `npm run test:coverage` | 65 files; 762 passed; global and per-file coverage thresholds passed |
| Full frontend lint and production build | Passed, including lint after the test-only changes |
| Prisma schema validation and form-policy parity | Passed |
| Bundled SOP/policy consistency | All 88 normative records match SOP 0.7 |
| Native desktop/admin → mobile/employee browser flow | Passed using real Express/React components and a disposable PostgreSQL schema, synthetic inference, no scheduler; no browser runtime errors |
| Disposable browser schema cleanup | Verified |
| Restarted local native backend | Ready; no queued, running, failed or expired-lease work; staged handoff retained |
| Repository diff/whitespace and QA secret scan | Passed |

The browser run covers the manual batch form and process endpoint, AI/human confirmation, a real employee task, absent-source handling, employee authorization and preserving an unknown power unit. Integration tests continue through employee response and reviewer verification.

The earlier real Sol run on WH603, WH1065, WH1570, WH3393 and WH3474 completed all five evaluations with 46 proposed flags under the still-current execution identity. Production source values/revisions and previous QA evidence were preserved. This audit did not make new model calls. The pilot verifies connectivity and behavior; it does not establish population precision, recall or capacity. The current profile has 43 deterministic and 14 semantic/presence checks; photos and undeclared SOP checks remain outside scope.

The backend suite retains an existing open-handle diagnostic in an unrelated PPT audit test and exits successfully. The frontend retains existing Ant Design/React test warnings and a large-bundle build warning. Remote CI, the Node 24 backend leg and a deployed-image smoke test have not been run locally.

## Push and deployment boundary

Use the [manual rollout runbook](warehouse-qa-rollout.md). A production deployment still needs the additive five-table migration, backend-only secrets, explicit shared QA storage, real handoff mode and a controlled deployed smoke test. These are deployment steps, not a requirement to build a scheduler or alerts. Existing Warehouse/WarehouseData columns are unchanged by this QA release.

Publish the backend and frontend changes together through review. Both `main` branches trigger deployment, so prepare and deploy the backend before releasing the frontend. The unrelated pre-existing `scripts/normalizeUploadedBy.js` edit is outside the QA change. Keep real snapshots, `.env`, credentials and workspace-only artifacts out of the push.

## Repeatable checks

- [Queue and manual resumption integration tests](../tests/integration/warehouseQa.test.js)
- [Native handoff, freshness and rollback tests](../tests/integration/warehouseQaHandoff.test.js)
- [Admin authorization and HTTP contracts](../tests/routes/warehouseQa.test.js)
- [Disposable browser fixture](../tests/helpers/warehouseQaHandoffBrowserServer.js)
- [Implementation and API reference](warehouse-qa.md)
- [Deferred scheduler/alerts and their acceptance criteria](warehouse-qa-future-automation.md)
