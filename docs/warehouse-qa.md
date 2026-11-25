# Warehouse QA in the dashboard backend

The dashboard's **Flagged for review → AI flags** stage uses `/api/ai-qa` on the existing Express application. It uses the normal frontend API client and dashboard JWT. Every review endpoint rechecks admin access against the active roster. It has no Vite proxy, separate Python service, browser API key, or development-only UI gate.

**The current release is manually triggered QA.** Admins enter WHIDs, review the suggestions and assign approved fields. A scheduler and automated alerts are deferred to [the later automation phase](warehouse-qa-future-automation.md); they are not requirements for using this manual workflow.

The current local configuration tests **production reads with local QA storage**, with assignment staging still enabled. WH603, WH1065, WH1570, WH3393 and WH3474 were previously evaluated through the native API using Sol and SOP 0.7. Saved evaluations remain historical evidence; runs without the current execution identity must be reevaluated before assignment. The original ten-snapshot pilot remains available as history.

Production handoff is implemented behind `AI_QA_HANDOFF=field-review`. Admin approval then creates flags through the normal field-review service, with the actual employee roster and existing assignee rules. QA approval never changes warehouse values: employees propose corrections and reviewers verify them through the existing workflow. The local configuration has not been switched to production handoff.

**SOP 0.7 is PEB-only.** The captured `warehouseType` must explicitly equal `PEB`, ignoring case and outer whitespace. RCC, BTS, Shed, mixed, unknown and missing types are skipped before deterministic checks or OpenAI requests. Broker exclusions still apply. All five PEB listings in the original ten-warehouse pilot remain eligible; the other five remain stored as historical records and do not contribute to the active review queue or metrics.

## Components

| Module | Responsibility |
| --- | --- |
| `src/warehouseQa/policy.v0.7.json` | Versioned structured SOP, extracted from the reviewed Markdown |
| `src/warehouseQa/eligibility.js` | Shared record scope for batch/cron evaluation, worker execution and review actions |
| `normalization.js`, `engine.js` | Decimal unit interpretation, deterministic checks, prompt construction and semantic-output validation |
| `inference.js` | Server-side OpenAI Responses API, `gpt-6.2-sol`, strict output, bounded timeout and validated cache |
| `source.js` | Saved pilot snapshots or projected, read-only warehouse snapshots |
| `repository.js` | Parameterized PostgreSQL queries, durable queue leases, pagination and atomic events |
| `worker.js` | Two processing lanes per process, a shared database concurrency cap, bounded retries and expired-lease recovery |
| `execution.js`, `modelConfig.js` | Persisted policy/engine/prompt/schema/model identity, checked before execution and handoff |
| `freshness.js` | Source-value and revision checks for approved findings and their evidence dependencies |
| `workflow.js`, `service.js` | Per-column decisions, admin-added flags, metrics, batch creation and forward cursor |
| `src/routes/warehouseQa.js` | Strict request contracts, fresh admin authorization and separate cron credentials |

The service is registered in the existing DI container. Routes mount in `src/app.js`; the queue pump starts and stops with `src/server.js`. Shutdown stops new claims, waits for active inference and HTTP transactions, and then closes database connections. Configuration errors leave ordinary warehouse endpoints available and make QA endpoints report their unavailability.

## Storage and setup

Five application tables store runs, items, events, inference cache and forward cursors. No Warehouse or WarehouseData column or trigger changes are needed. JSON documents retain versioned raw snapshots, predictions and adjudications; indexed columns hold queue state, leases, identities and timestamps.

Use `AI_QA_DATABASE_URL` explicitly; the application never migrates automatically. In default staged mode it opens that separate connection and never falls back to `DATABASE_URL` for QA writes. `AI_QA_SOURCE=pilot` additionally requires a loopback database host. Source capture uses a repeatable-read, PostgreSQL-enforced read-only transaction and a projection that excludes contacts, addresses, media and scout notes. Local storage cannot override its host using connection URL parameters.

Real handoff requires `AI_QA_SOURCE=warehouse` and matching database host, port, database name and schema in `AI_QA_DATABASE_URL` and `DATABASE_URL`. The service then uses the existing field-review Prisma client for both QA and employee review writes. Its constructor also checks that the actual client is shared. Approval, source checks, task creation and both audit trails commit or roll back together. Separate QA and employee databases are deliberately unsupported for real handoff. The existing local QA database plus production source therefore cannot accidentally enable that mode.

Settings:

| Setting | Meaning |
| --- | --- |
| `AI_QA_ENABLED=true` | Enable the native service and queue pump |
| `AI_QA_SOURCE=warehouse` | Read fresh warehouse snapshots; `pilot` reads the imported snapshot cache |
| `AI_QA_DATABASE_URL` | Explicit QA storage destination |
| `AI_QA_HANDOFF=staged` | Default: save assignment locally; `field-review` enables the atomic employee workflow and requires shared storage |
| `OPENAI_API_KEY` | Existing backend credential, never sent to the frontend |
| `AI_QA_CRON_SECRET` | Future automation only: separate random secret of at least 32 characters; manual QA does not need it |
| `AI_QA_RUN_BY=Raghav` | Operator metadata; authenticated `executedBy` is recorded separately |
| `AI_QA_FORWARD_START_AT` | Future automation only: explicit initial forward-scan timestamp |
| `AI_QA_MAX_CONCURRENCY=2` | Global active-lease cap across all replicas; integer from 1 to 20, consistently configured on every replica |

Run `node scripts/migrateWarehouseQa.js` for a dry run, then add `--apply` against the intended QA database. The migration verifies row-level security and revokes direct access from public/API roles. Only the backend database role should access these tables. Local pilot import is an explicit one-time operation through `scripts/importWarehouseQaPilot.js`; its local database guard prevents production imports and reruns never reset admin decisions.

Start the application normally with `npm start`. For a local listener, use `HOST=127.0.0.1 npm start`. PostgreSQL is the only additional runtime service; the pilot currently uses Podman with a persistent named volume. Restart the existing container with `podman start wareongo-dashboard-qa` if needed.

## API

All responses use the existing `{ success, data }` / `{ success: false, error: { code, message } }` envelope. All admin operations use `Authorization: Bearer <dashboard JWT>`.

| Method and path under `/api/ai-qa` | Behavior |
| --- | --- |
| `GET /config` | Policy profile, execution identity, allowed columns and handoff mode |
| `GET /health` | Admin-only queue health and configuration readiness |
| `GET /summary` | Pending warehouse and column counts across batches |
| `GET /runs` | Pending inbox and recent batches |
| `POST /runs` | Queue 1–100 unique WHIDs; reject the whole batch with 409 if an eligible WHID already has open QA/review work |
| `GET /runs/:id/status` | Durable queued/running/completed/failed/skipped counts |
| `POST /runs/:id/process` | Admin-only bounded processing of existing queued work, with body `{}`; returns run status and never creates another batch |
| `GET /runs/:id/warehouses` | Paginated reviews; `inbox` includes pending reviews across runs |
| `GET /runs/:id/warehouses/:whid` | Snapshot, findings, decisions, per-WHID activity and current assignment options |
| `POST /runs/:id/warehouses/:whid/:operation` | `decision`, `admin-flags`, `remove-admin-flag`, `review-clean`, `confirm`, or `retry` |
| `GET /runs/:id/export` | Predictions, decisions and events; bounded to 1,000 reviews |
| `POST /cron` | Service-authenticated enqueue and bounded queue drain |
| `GET /cron/health` | Service-authenticated queue health; no warehouse values or review decisions |
| `POST /cron/drain` | Service-authenticated bounded drain without enqueuing another scan; body `{}` |

Admin batch body:

```json
{
  "request_id": "b9bcab52-8771-498d-b78b-b552eb783a26",
  "warehouse_ids": [354, 603, 3474],
  "mode": "BACKFILL",
  "model": "gpt-6.2-sol"
}
```

`mode` can also be `NEW_SUBMISSION` or `RECHECK`. Recheck formatting uses explicit provenance where available; unknown provenance retains the SOP's legacy leniency. No magnitude-based kVA inference or bare highway-unit inference is permitted.

### Repeat warehouse submissions

Duplicate IDs inside one request are rejected with 400. Replaying the same request ID and unchanged body returns the existing run. A new request ID does not bypass warehouse admission: queued/running evaluations, pending AI decisions under the current execution contract, staged assignments and open native employee/manual reviews block another batch for that WHID. The API returns `409 QA_WAREHOUSE_IN_PIPELINE` with the conflicting IDs; the entire manual batch is rejected before creating a run, audit event or model request. The dashboard keeps the entered IDs and displays the explanation so the admin can open the existing review or remove the conflicting IDs.

Admission takes transaction-scoped locks in WHID order and reads committed state after acquiring them. Concurrent requests, including requests to different backend instances, therefore cannot both admit the same warehouse. Failed evaluations are retried through their existing review. A client-supplied `RECHECK` mode does not bypass the guard. Source-freshness rechecks created by the backend remain part of the existing workflow and preserve its history.

Closed/dismissed reviews permit a later evaluation. A changed SOP/engine execution contract also permits replacement of an old, non-actionable AI evaluation; queued work and open employee assignments still block admission. Historical results and saved notes are preserved. Existing legacy duplicates retain their original supersession/history behavior; this guard does not bulk-delete or reject historical reviews.

Future forward scans share the admission locks and skip open WHIDs, recording `duplicate_warehouse_ids` in run metadata while continuing the scan cursor. They do not create duplicate review cards or stall an entire scan page. Scheduling remains disabled for the current manual release.

Review writes require a new `request_id` and the currently displayed `expected_version`. The same request ID replays a lost response; reusing it for a different operation returns 409. A successful mutation and its WHID-scoped audit event commit together. Stale edits return 409. The event includes the authenticated actor and `runBy` metadata.

The manual UI advances queued work through `POST /runs/:id/process`, with a 105-second client timeout around the bounded worker call. It does not rely on background CPU or a cron token. Reloading the page discovers unfinished runs before completed history and resumes processing; a failed status/processing request offers Resume QA for the existing run. Refresh also discovers retries and rechecks queued during adjudication. Closing the page preserves all queued work for resumption on return. The normal worker timer remains an opportunistic helper and never selects newly submitted warehouses by itself.

The queue uses the employee view's `CardView` / `SimpleWarehouseCard` grid, with QA status and source counts. Each page makes one bounded read through the existing warehouse service for photos, image variants, labels and surrounding context. Captured QA fields override current values in that display record, so findings retain their original evidence. Cards omit live contact-reveal controls and retain each review's run identity. A missing warehouse preserves its saved review in read-only mode while neighboring cards stay usable. A temporary context outage preserves saved cards and offers Retry source; assignment stays disabled until context recovers. Authentication/authorization failures still close access. Photos are display context only; they are not added to the text-only inference payload.

Opening a card reuses `WarehouseDetailsModal`, its normal photo gallery and flag-selection controls. AI suggestions start checked with their explanations in the editable comments. Purple ticks identify AI suggestions; yellow ticks identify human additions. Ticks and comments remain drafts until the admin reviews the summary and confirms. Snapshot mode uses the supplied image records and labels, disables additional live-data lookups inside the modal, and preserves stored measurement text without adding default units. Manual and AI flagging share `FieldReviewConfirmation`, including formatted values, comments, source badges and the assignee control. QA confirmation also preserves recorded units; missing historical field-editor identities display as not recorded.

The queue uses one toolbar. Review metrics and batch history are available under **Review stats**; there is no export action or introductory banner. Filter and card stage labels share a single frontend definition: **Pending review**, **Approved for assignment** (staged), **Assigned to employee**, **Needs fresh evaluation**, **Dismissed**, and **Previous evaluation**, with **All stages** for history. Completed native handoffs link to the ordinary employee review. AI/human source badges remain visible beside comments in that review. QA-origin values retain their recorded units in current values and history. An employee editing a unitless number must explicitly select its unit; a bare power value is never silently labeled kVA by that QA review.

SOP 0.6 distinguishes `MISSING_REQUIRED` (actually blank) from `REQUIRED_PLACEHOLDER` (a supplied placeholder without an approved exception). Policy-owned comment templates supply short field-specific review instructions. Read responses add a `suggested_note` for existing pilot findings without rewriting their original explanations, verdicts, decisions or admin notes; the frontend uses it only for the editable initial suggestion. Model explanations must describe the concrete issue and next action in plain language. Existing evaluations remain historical; revised verdicts require a new QA run.

`As per requirement` / `APCR` in Fire Safety Measures is an accepted conditional client-provision answer, resolved by host literal matching. It does not assert installed equipment or current NOC possession. The NOC cross-check includes this field as context and accepts `false` with conditional provision and a bare `Fire NOC` certificate-type label. Explicit claims of current possession still conflict with `false`. A floor-strength value such as `5 mtr/sqm` receives a unit clarification (`REVIEW`), not an invalid-number finding; no source values are corrected.

`confirm` also accepts an optional `review` object: `machine` contains every AI candidate as `{field_key, decision: "APPROVED" | "REJECTED", note, reason}`; `human` contains the complete desired set of human flags as `{field_key, note, missed_rule_id}`. Selected fields require comments, rejected AI candidates require a reason and explanation, and every field key must be distinct. All decisions, the handoff and one WHID-scoped `CONFIRM` audit entry commit together. A stale form fails without overwriting the newer review. The earlier individual-decision endpoints remain supported.

Native confirmation takes the existing warehouse row locks and reloads current evidence inside the same transaction. Approved machine findings guard their target field and the SOP rule's input dependencies; human additions guard all captured QA fields because free-form notes may refer to surrounding evidence. Source values and field revision counters are checked. PEB/broker eligibility is checked again. Changed evidence preserves the old evaluation, submitted decisions and audit, sets `STALE`, queues a fresh `RECHECK` when the source still exists, and returns `409 QA_SOURCE_CHANGED` without creating tasks. Deleted sources retain history without scheduling impossible work. Unrelated edits do not invalidate a machine finding.

The active roster and any existing manual review are rechecked in the transaction. Duplicate active fields are rejected, the existing assignee is retained, and existing manual comments are preserved. The normal field-review `CREATED` event records each new field's AI/HUMAN origin, run ID, snapshot ID, execution hash, `runBy` and authenticated `executedBy`. A failed audit write rolls back the task and all decisions. Replaying a successful confirmation returns its original result without creating another task.

Pagination accepts `page`, `limit` (maximum 100), `search`, and `stage` (`AI_REVIEW`, `ASSIGNED_LOCAL`, `ASSIGNED`, `STALE`, `DISMISSED`, `SUPERSEDED`, `all`). Counts are computed across the filtered result, independently of the displayed page. Reviews keep their actual run IDs even when opened from the combined inbox.

After a successful replacement evaluation, a per-warehouse transaction lock moves older untouched pending reviews to `SUPERSEDED`. It retains their snapshots, predictions, model artifacts and prior audit events, and adds one `QA_REVIEW_SUPERSEDED` event per warehouse with `runBy`. The newer evaluation must finish successfully first; failures leave the previous review available. Saved decisions, human flags, comments and clean-review annotations prevent automatic supersession. Concurrent workers use creation order rather than completion order, so a slower old job cannot replace a newer result. Superseded reviews remain readable under Previous evaluation and reject further decisions or retries. Browser drafts receive a conflict if their underlying review has been superseded.

Scope is applied before SQL pagination and aggregate counts. Run summaries report both total submitted warehouses and `eligible_warehouse_count`. Detail and decision exports retain historical results and expose `eligible_for_review` / `scope_exclusion`; out-of-scope history is read-only. Review mutations and direct engine calls reject excluded records. The worker rechecks scope for work queued under older policies, preserving any prior evidence and writing one lease-fenced, WHID-scoped `QA_SKIPPED` audit event with `runBy` metadata. New mixed batches audit skipped IDs without creating findings or making model calls. Forward scans may encounter excluded IDs to advance their cursor correctly; the same scope gate prevents their evaluation.

Existing pending reviews can be explicitly removed from the queue with `node scripts/archiveOutOfScopeQaReviews.js <run-id>` (preview) and `--apply` (archive). This maintenance command requires the isolated local `AI_QA_DATABASE_URL` and never falls back to the warehouse database. It changes only excluded `AI_REVIEW` records to `OUT_OF_SCOPE`, increments the review version, and commits one `QA_REVIEW_REMOVED_FROM_SCOPE` event per WHID with `runBy: Raghav`. Original predictions, decisions, notes, snapshots, model artifacts and earlier audit events are retained. Repeating the command makes no additional changes. Already assigned or dismissed reviews are unaffected.

## Queue execution and later automation

The worker uses a 75-second processing budget and a 55-second timeout per OpenAI request. Remaining work survives process restarts in PostgreSQL. Multiple instances claim work with `FOR UPDATE SKIP LOCKED`; lease tokens prevent an expired worker from overwriting its replacement. A database advisory lock serializes admission against the global active-lease limit. Each process has two lanes. Exhausted failures remain visible and not evaluated; an admin can retry them when their execution contract is unchanged.

Hourly selection, an external runner and alerting are deferred. The cron endpoints and runner templates are inactive scaffolding for [future automation](warehouse-qa-future-automation.md). Manual QA uses dashboard authentication and the processing endpoint above.

Health reports queued/running work, active failed evaluations, expired leases, oldest pending age, policy mismatches and the concurrency cap. `ready` is false for missing model configuration, a stopping worker, active failures, expired leases or work pending for at least an hour. It checks stored configuration and queue state; it does not perform a paid model request or prove provider reachability. Historical archived failures do not keep the active queue unhealthy.

Every run pins a hash of the policy, field registry, engine/prompt code, response schema and model settings. The worker compares it before calling OpenAI; a mismatch produces an explicit `POLICY_CHANGED` failure with no invented findings or provider call. Confirmation and retry also reject an obsolete execution contract. Start a new batch after deploying changed evaluation code or policy. Cache entries include the same identity. This deliberately favors an explicit recheck over silently interpreting old evidence under new rules.

## Evaluation and rollout boundaries

This is the declared text/cross-field pilot profile, not all 88 SOP records: 43 deterministic checks plus 14 semantic/presence checks per warehouse. Photos, geography, personal contacts, handover/date rules, land parcel size and other undeclared checks remain outside scope. Coverage is shown in the review dialog.

The model receives only required text dependencies, with listing text treated as untrusted input. No tools are enabled; `store` is false. Output validation rejects extra/duplicate/omitted pairs, unauthorized case codes, forged evidence pointers/quotes, mismatched request IDs and fabricated host preflight outcomes. Source values stay unchanged. Invalid output is never treated as clean.

Only `INCORRECT` rejections count as false positives. Admin-added misses must identify a specific passed check; other additions are coverage gaps. Only explicitly reviewed, covered columns count as clean. The selected ten warehouses are a UX/refinement corpus, not a population accuracy estimate.

Local assignments remain staged by configuration. Real handoff is covered by disposable database and native browser checks. Manual production rollout requires the additive migration, production secrets, `field-review` handoff mode and the normal deployment smoke check. The scheduler and automated alerts are a later phase. No production migration or scheduler has been applied during this work. See [the readiness report](warehouse-qa-production-readiness.md).

## Verification

Unit and route tests live under `tests/warehouseQa` and `tests/routes/warehouseQa.test.js`. PostgreSQL tests in `tests/integration/warehouseQa.test.js` and `warehouseQaHandoff.test.js` create and drop randomly named schemas in the guarded local test database. They exercise concurrent claims across replicas, expired-lease fencing, request replay, stale decisions, transactional employee handoff, source edits racing with approval, audit rollback, policy drift, failed-model coverage, retry, pagination, forward overlap and cursor rollback. Scheduler tests cover lost responses, checkpoint recovery, continuation and queue drainage.

The saved corpus has been compared across the Python reference and native engine: 491 host checks match, and all 79 original Sol judgments pass native validation. Browser checks exercise the actual React screens and native API against a disposable local PostgreSQL schema; fixture authentication never grants production access.

Run `node scripts/checkWarehouseQaPolicy.js <path-to-final_warehouse_QA_SOP.md>` after SOP changes. It verifies all 88 bundled records against the Markdown's normative JSON records. Tests also check that QA columns remain compatible with the existing manual-review field registry.

Queue `COMPLETED` means processing finished. The separate `coverage.evaluation_status` remains `PARTIAL` when a requested check lacks evidence, even after a successful model response; `sop_coverage` remains `PARTIAL_PROFILE` because the declared pilot does not implement every SOP rule.
