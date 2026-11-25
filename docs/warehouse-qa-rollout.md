# Manual warehouse QA rollout

**Current release: an admin starts QA for selected warehouse IDs, reviews the flags, then assigns approved fields through the normal employee workflow.** A scheduler and automated alerts are not prerequisites. Their backlog and inactive templates are documented in [future automation](warehouse-qa-future-automation.md).

This is a deployment procedure, not a record of a completed production deployment. See the [readiness report](warehouse-qa-production-readiness.md) for verification. Local source reads and disposable fixture tests have not created production employee tasks.

## Database and configuration

1. Keep `AI_QA_ENABLED=false` while preparing the environment. Use the existing application PostgreSQL database/schema for QA and normal field reviews. The five QA tables are additive; Warehouse/WarehouseData columns are unchanged. The normal field-review migration must already be present.
2. Set `AI_QA_DATABASE_URL` explicitly. Run `node scripts/migrateWarehouseQa.js` to inspect the target, then `node scripts/migrateWarehouseQa.js --apply` during the approved rollout. Repeat the inspection to check all five tables, RLS and revoked public/API-role access. Follow the normal backup procedure. Do not run the local pilot import against production.
3. Configure the backend through its secret store:

| Setting | Manual production value |
| --- | --- |
| `AI_QA_ENABLED` | `true` after migration |
| `AI_QA_SOURCE` | `warehouse` |
| `AI_QA_HANDOFF` | `field-review` |
| `AI_QA_DATABASE_URL` | Explicitly the same host, port, database and schema as `DATABASE_URL` |
| `OPENAI_API_KEY` | Server-only key with access to the configured Sol model |
| `AI_QA_RUN_BY` | `Raghav`; the authenticated actor is also recorded separately |
| `AI_QA_MAX_CONCURRENCY` | Start at `2`, consistently on every replica |

`AI_QA_CRON_SECRET`, `AI_QA_FORWARD_START_AT`, an external runner and alerts are **not needed for manual QA**. Leave hourly scheduling disabled. No QA secrets belong in the frontend bundle.

Real handoff uses the existing field-review Prisma client for QA writes and task creation in one transaction. Verify that the application's runtime database role can access the migrated QA tables, even if migrations use a separate account. Separate QA and employee databases are unsupported for real assignment.

For isolated local testing against a read-only production source, keep `AI_QA_HANDOFF=staged` and QA storage local. That mode deliberately saves staged assignments rather than creating production tasks. Do not copy that handoff setting into a production release that needs actual assignments.

## Deploy and verify the manual workflow

Deploy matching backend and frontend releases through normal CI. Both repositories deploy on a push to `main`; the frontend is currently checked out on that branch. Prepare the migration/configuration and deploy the backend before publishing the frontend. Use feature branches/PRs for review; do not treat a push to `main` as a review-only action.

Query admin `/api/ai-qa/config` and `/api/ai-qa/health` to verify source, handoff mode, execution hash, storage access and queue state. Existing warehouse and manual field-review endpoints must remain functional. Health verifies local configuration/queue state; it does not make a paid model request.

Use an authorized controlled PEB batch in **Flagged for review → AI flags → Run QA**. The UI enqueues once and calls admin-only `POST /api/ai-qa/runs/:id/process` with `{}` to advance existing work. This keeps processing inside HTTP requests and does not depend on idle background CPU. Each call uses the bounded worker; the browser allows 105 seconds. Background timers remain opportunistic helpers, never selectors of new warehouses.

Progress is stored in PostgreSQL. Reopening AI flags discovers unfinished runs before completed history and resumes them; a lost processing response can be resumed without creating another batch. If the page is closed, work remains saved and can resume on return. Do not promise unattended completion while all clients are closed on a host with suspended background CPU—that is the later automation phase.

Verify prefilled comments, purple AI/yellow human ticks, per-column approval/rejection, added human notes and real assignees. Confirm a chosen warehouse and inspect the ordinary employee task, including AI/Human attribution and audit provenance. QA approval must leave warehouse values unchanged. Employee-proposed corrections enter the existing reviewer verification flow.

Verify a source change during review, a duplicate manual field, lost-response replay, page reload and worker restart. Changed evidence must preserve the old review and queue a fresh evaluation, never assign stale findings. Assignments and later verified corrections are production writes and belong to the approved rollout, not an incidental read-only smoke test.

## Recovery and release scope

Failed evaluations remain visible and cannot be treated as clean. Restore provider connectivity/configuration before retrying. A policy/engine/schema/model change requires a new batch; old evaluations remain history. The current profile covers PEB text/cross-field checks. Photos and undeclared SOP rules are outside scope.

Publish the QA source, route/container integration, additive schema/migration, frontend components/services, tests and these docs together. The backend's pre-existing `scripts/normalizeUploadedBy.js` edit is unrelated and should not be included in this QA change accidentally. Keep `.env`, private production snapshots and workspace-only reports out of commits; the runtime needs the bundled policy JSON, not a neighboring lab directory.

To disable the feature, set `AI_QA_ENABLED=false` and restart the backend. Let active HTTP transactions finish before disconnecting storage. Preserve QA tables and audit history; existing employee tasks continue through the ordinary workflow. Switching handoff to `staged` prevents new real assignments without retracting tasks already created.
