**Backend behavioral fixes and verification — 13 September 2026**

All seven behavioral findings from the September 11 audit have been addressed.
The working tree is based on `d9dae8c`; the repository had advanced since the audit.
The sections below record the initial local verification. The final pre-commit
audit and its additional checks are recorded at the end of this report.

**Changes and regression evidence**

| Finding | Resulting behavior | Verification |
|---|---|---|
| B1 — inactive staff retain capabilities | Capability resolution selects `is_active` and denies every database-derived capability unless it is explicitly true. The existing `ADMIN_EMAILS` emergency override remains intentional. | Active/inactive role matrix; real roster PATCH followed by protected requests with the existing JWT; deactivation during a pending lookup. |
| B2 — reopening loses the warehouse link after failed deletion | One parameterized PostgreSQL statement resets the staging row and deletes the approved warehouse atomically. Failed deletion rolls back the reset. Status, link, reviewer, and review timestamp guard against stale snapshots. Audit metadata records a removal only when an object was actually deleted. | 12 real PostgreSQL cases: cascade, restricted-delete rollback, retry, missing master, rejected/unlinked rows, invalid states, stale snapshots, and 30 competing reopens. Production HTTP success/404/409/500/permission paths are covered separately. |
| B3 — concurrent Scout lookups overwhelm the cache | Concurrent cold lookups share a pending promise. Failures are not cached. Invalidation prevents old pending results from restoring revoked access. Roster writes invalidate Scout and capability entries, including old/new identities. | A genuinely overlapping 30-request Scout burst; a 100-request cache burst; expiry, failure recovery, per-key/global invalidation, and in-flight revocation tests. |
| B4 — database admins cannot delete | Both warehouse and file deletion use `requireAccess(CAPS.ADMIN)`. | Production route matrix for database/environment admins, inactive users/admins, dashboard users, reviewers, missing roster entries, and anonymous requests. Unauthorized calls perform no mutation. |
| B5 — uploaded-file validation always succeeds | Validation makes an S3 HEAD request and checks object existence, allowed MIME metadata, and a positive known size up to 10 MiB. Callers may lower the size limit; they cannot disable checks or raise the server limit. | Allowed MIME types; empty/unknown/invalid/oversized sizes; boundary size; missing objects; storage outages; stricter limits; invalid/bypass options. Invalid metadata returns `isValid: false`; missing objects return 404. |
| B6 — email-only create fails at persistence | Creating staff requires a valid phone number in both the HTTP schema and service. Email remains optional. | Email-only/null/empty/invalid-phone rejection before writes, phone-only and phone-plus-email creation, normalization, and existing uniqueness/identity/admin safeguards. |
| B7 — malformed IDs and request bodies produce wrong errors | Warehouse IDs must be complete positive integers within PostgreSQL int32 range. Malformed JSON returns 400, oversized bodies 413, and unsupported body encodings 415. Parser messages do not reflect request contents. | Production HTTP cases for numeric suffixes, decimals, exponents, nonpositive and overflow IDs; malformed JSON and oversized bodies. |

Relevant implementation: `src/utils/access.js`, `src/utils/lookupCache.js`,
`src/middleware/scoutMiddleware.js`, `src/models/stagedWarehouseModel.js`,
`src/routes/warehouse.js`, `src/services/fileUploadService.js`,
`src/services/verifiedNumberService.js`, validators, and the shared controller/error handler.

The main regressions are under `tests/regression/`, `tests/integration/`,
`tests/utils/lookupCache.test.js`, `tests/utils/capabilityCache.test.js`, and
`tests/middleware/scoutMiddleware.test.js`.

**Application and CI wiring**

`src/app.js` now exports the actual Express app without connecting or listening.
`src/server.js`, invoked by `index.js`, retains process startup and existing server
timeouts. Tests exercise production routers, authentication, controllers,
services, and models while replacing database/storage boundaries. The duplicated
`src/app-test.js` and `src/routes/warehouse-test.js` implementations were removed.
A separate startup test verifies that the production entrypoint connects and listens.

The reusable CI workflow runs unit/HTTP tests and coverage on Node 22/24,
PostgreSQL 16 rollback/concurrency tests, and offline deck XML/content evaluation.
The deployment workflow now calls those same gates and waits for all of them.
Coverage and deck artifacts are retained, and jobs have time limits. Production
secrets are not passed into QA jobs. The Docker runtime now uses Node 22.
Node 22 and 24 are supported LTS lines according to the
[Node release schedule](https://nodejs.org/en/about/previous-releases).

The previously failing deck evaluator now uses the current default v3 layout
(connectivity is opt-in; pros/cons pages are included) and a synthetic Mapbox token
for deterministic blocked-network checks. It no longer loads `.env`.

**Executed verification**

| Check | Result |
|---|---|
| Full Jest suite on local Node 22.21.1 | **1,027 passed; 53 suites; zero failed/skipped tests**, exit 0; 16.658 seconds |
| PostgreSQL 16 integration | **12 passed**, including one winner and 29 conflicts in the concurrent reopen test |
| Offline deck XML/content evaluation | **54 passed**, zero failed; 12 render checks explicitly skipped by `--no-render` |
| Full deck evaluation with LibreOffice/Poppler | **66 passed**, zero failed/skipped; all six variants rendered |
| Regression challenge against original source in a separate copy | **55 expected failures / 39 passes** across five suites, showing that the added tests detect the original authorization, cache, validation, and request-error defects |
| Node 22 Alpine production image | Build passed, including a clean production dependency install and Prisma generation |
| Built-image smoke check against disposable PostgreSQL | `/` and `/health` both returned 200; database health was connected |
| GitHub workflow validation | Both workflows passed `actionlint` |
| JavaScript syntax | 38 changed/new files passed `node --check` |
| Diff whitespace | `git diff --check` passed |
| Protected file hashes | `.env`, `.env.bak`, `.env.example`, Prisma schema, and package lock unchanged; the pre-existing README configuration notes were preserved while its testing/deployment sections were updated |

The initial cached container build exhausted temporary storage after dependency
installation. Unused layers in this task's dedicated Podman store were removed;
a build without layer caching then succeeded. No shared container store was pruned. Both QA containers were stopped after verification, and their images were removed from the task-specific store.

**Measured coverage**

| Metric | Result |
|---|---:|
| Statements | 57.62% |
| Lines | 57.92% — 3,559 / 6,144 |
| Branches | 48.77% — 1,852 / 3,797 |
| Functions | 54.13% — 629 / 1,162 |
| Capability resolver | 100% lines; 92.85% branches |
| Shared lookup cache | 100% lines; 95.23% branches |
| Scout middleware | 100% lines and branches |
| File upload service, including unrelated upload methods | 54.31% lines; 38.80% branches |
| Verified-number service | 88.04% lines; 78.37% branches |

Coverage includes production source. Process startup is excluded from percentage
collection but has a wiring test and the built-image smoke check. PostgreSQL and
standalone deck evaluations are separate from these coverage numbers. The original
audit measured 48.83% line coverage on an earlier checkout, so that comparison is
indicative rather than a controlled measurement of this patch alone.

Jest now enforces global regression floors and stricter per-file authorization/cache
floors. Passing these floors does not mean the whole backend has adequate coverage.

**Database safety and practical limits**

No live database reads or writes, migrations, schema push, backfills, production API
calls, or deployments were performed. Database tests used a newly created local
PostgreSQL container with synthetic credentials and randomized disposable schemas.
The image smoke check used that same test database. Unit setup blocks native Prisma,
checkout dotenv loading, unmocked fetch, and external socket connections. The
integration setup rejects every URL except the dedicated localhost test identity
and database; it never falls back to the application's database environment.

The integration fixtures cover the columns and constraints relevant to reopening.
They do not establish compatibility with all production data, extensions, row-level
security, migrations, or the live Supabase pooler. S3 is replaced at the SDK boundary;
real R2 configuration and service behavior were not contacted.

Remaining work for subsequent QA iterations:

- **Coverage breadth:** more production-route and persistence tests, especially
  untested upload/presigning paths and other model/service failures.
- **Audit durability:** reopen audit insertion remains best-effort and follows the
  atomic state change; a later audit-write failure can still leave no audit entry.
- **Cache propagation:** invalidation is immediate within this process. Other
  instances and direct SQL edits remain bounded by the existing 30-second
  capability / 60-second Scout TTLs. JWT-only endpoints and environment-admin
  access retain their existing policies.
- **File validation scope:** HEAD checks stored metadata, not file bytes, malware,
  or image integrity. This endpoint does not enforce the size limit during the
  direct upload itself.
- **Dependency advisories:** dependencies were not upgraded. The production image
  install still reported 37 affected dependency entries, including one critical
  and 12 high; exposure and remediation need a separate review.
- **Test cleanup diagnostic:** Jest still reports the pre-existing
  `bound-anonymous-fn` handle originating in the audit invalid-token test. The
  process exits naturally with code 0; `forceExit` has been removed. A permanent
  resource leak has not been established.
- **Remote enforcement at initial verification:** GitHub Actions and branch
  protection settings had not been exercised. Node 24 was subsequently verified
  during the pre-commit audit below; require appropriate checks when submitting.

Reproduction commands and test boundaries are documented in
[tests/README.md](../../tests/README.md). Raw local evidence is retained in the
workspace's `qa-reports/backend-behavior-fixes-2026-09-13` directory.


**Pre-commit audit — 13 September 2026**

Reviewed the production diff, cache invalidation and concurrency semantics,
parameterized reopen SQL and its fixtures, role gates, input contracts, startup
separation, test isolation, container configuration, and both workflows. Two gaps
were found and corrected before committing:

- The shared test setup called `jest.setTimeout(10000)`, overriding the intended
  30-second integration timeout. Unit timeout now lives in `jest.config.js`;
  integration retains its separate 30-second setting. Resolved Jest configuration
  was checked for both suites.
- Direct service calls with a truthy non-string phone could pass the new presence
  check. The service now rejects these before any identity lookup or write, with
  regression cases for missing, null, numeric, boolean, object, array, empty, and
  invalid string values.

Added production HTTP assertions for unsupported charset/content encoding (415)
and an error-handler assertion that an already-started response is delegated rather
than written twice. The final suite passed **1,037 tests across 53 suites** on both
**Node 22.21.1** and **Node 24.21.0**, including coverage gates. Node 24 was downloaded
from the official release and verified against its published SHA-256 checksum.
Final coverage: **57.66% statements, 57.93% lines, 48.88% branches, 54.13% functions**.
The existing open-handle diagnostic remains; both runs exited naturally with code 0.

Both workflows passed `actionlint`, and the diff passed whitespace checks. The
prior PostgreSQL, rendered-deck, and image-build/smoke evidence above remains
applicable; those production paths were unchanged by this final audit. The remote
main branch matched `d9dae8c` before the commit. No additional release-blocking
issue was found in this change set; the documented remaining QA work still applies.

The commit deliberately excludes pre-existing edits to `.env.example` and the
README's Supabase connection notes. Those edits remain in the working tree.
