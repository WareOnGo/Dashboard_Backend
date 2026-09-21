# Backend testing

Run from the backend repository on Node 22 or 24.

```bash
npm ci
npm test -- --runInBand
npm run test:regression
npm run test:ci
```

`test:ci` runs the full unit/component/HTTP suite with coverage and enforced
coverage floors. `test:regression` selects the audited behavioral fixes and the
production application/warehouse wiring. Neither command needs a database.

**Isolation**

`tests/isolation.js` runs before application imports. It disables dotenv loading,
sets synthetic configuration, blocks native Prisma construction, rejects external
socket connections, and blocks unmocked fetch. Tests replace database/storage
boundaries explicitly. Never remove these guards to make a test pass.

`tests/helpers/app.js` imports `src/app.js`: the actual middleware, routers,
authentication, dependency container, controllers, services, and models. Only the
Prisma and S3 boundaries are replaced. The former `app-test.js` and
`warehouse-test.js` copies have been removed. `src/server.js`, invoked by
`index.js`, owns database connection, process handlers, and listening; importing
the Express app does not start the server or connect to a database.

Older focused suites still use local routers/services and mocks. Their passing
results should not be read as coverage of every production route.

**Real PostgreSQL regression tests**

Use a disposable PostgreSQL 16 container with synthetic credentials:

```bash
docker run --detach --rm --name warehouse-qa-postgres \
  -e POSTGRES_USER=warehouse_test \
  -e POSTGRES_PASSWORD=warehouse_test \
  -e POSTGRES_DB=warehouse_qa \
  -p 127.0.0.1:55439:5432 postgres:16-alpine

docker exec warehouse-qa-postgres pg_isready -U warehouse_test -d warehouse_qa

TEST_DATABASE_URL=postgresql://warehouse_test:warehouse_test@127.0.0.1:55439/warehouse_qa \
  npm run test:integration

docker stop warehouse-qa-postgres
```

Wait until `pg_isready` reports accepting connections before running tests. Podman
can run the same disposable-container flow. The integration command fails without
`TEST_DATABASE_URL`; it never falls back to `DATABASE_URL` or `DIRECT_URL`.
The guard accepts only the exact test username/password, `127.0.0.1`, an explicit
port, and database `warehouse_qa`. Redirecting query parameters are rejected.

Every run creates a random `behavior_qa_*` schema and removes only that schema on
completion. The fixtures contain the columns and foreign-key constraints needed
for reopening. They exercise the production model's parameterized SQL and the
real Prisma client against PostgreSQL, including rollback after a restricted
DELETE, cascade behavior, stale snapshots, retry, and 30 competing requests.
The warehouse-search suite also verifies phone formatting and Indian dialling
prefixes against primary/alternate contacts, list/count/map agreement, and
composition with location, numeric ranges, explicit IDs, and pagination.
These tests do **not** validate all production tables, PostGIS/vector extensions,
Supabase pooler configuration, or migration history. No schema push, migrations,
production seed, or shared database is involved.

**Deck regression evaluation**

```bash
npm run ppt:eval -- --no-render
npm run ppt:eval
```

The evaluator uses synthetic warehouses and a local image server, refuses external
HTTP, and does not load `.env`. A dummy Mapbox token exercises the refused-request
fallback. XML/content checks run without extra system packages; rendering requires
LibreOffice and `pdftoppm` (Poppler). The full evaluator explicitly reports when
rendering is unavailable. Output: `tools/ppt-preview/out/eval/report.html`.

**Coverage and CI wiring**

Coverage appears in `coverage/index.html` and `coverage/lcov.info`. Jest excludes
only process startup and test files from production-source coverage. PostgreSQL
and standalone deck evaluation are separate checks and are not included in the
unit coverage percentages.

Current thresholds are global floors of 55% statements/lines, 46% branches, and
51% functions; authorization/cache files have 100% line floors and 90–100% branch
floors. Jest subtracts files with their own thresholds from the global threshold
calculation. These are regression floors, not a claim of adequate overall coverage.
Raise them as meaningful tests are added.

`.github/workflows/ci.yml` runs on PRs targeting `main`, manual dispatch, and
`workflow_call`. Its required jobs within the workflow are:

- Full suite and coverage on Node 22 and 24, with coverage artifacts.
- PostgreSQL 16 integration tests with a disposable service container.
- Offline deck XML/content evaluation, with the HTML/PPT artifacts.

`deploy-ecr.yml` calls that same workflow on pushes to `main`; image publication
waits for every job to pass. No production secrets are passed into the QA workflow.
Branch protection still needs to require the appropriate checks in GitHub settings;
a YAML file cannot enforce that repository setting. Remote runs and branch rules
must be verified when these changes are submitted.
