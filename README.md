# WareOnGo Dashboard — Backend API

Node.js / Express REST API backing the WareOnGo warehouse platform. It is the single
write path for warehouse data: everything that arrives from the internal dashboard, the
public Scout form, or partner webhooks lands in a **staging table**, gets reviewed by a
human, and only then is promoted into the master `Warehouse` table.

- **Runtime:** Node 18+ (Docker image is `node:18-alpine`), Express 5
- **Data:** PostgreSQL (Supabase) via Prisma 6
- **Object storage:** Cloudflare R2 (S3-compatible), direct browser uploads via presigned URLs
- **Auth:** Google OAuth → own JWT, plus capability flags resolved per request from the DB
- **Deploy:** GitHub Actions → Docker → AWS ECR → App Runner

**Consumers**

| Client | Repo | Talks to |
|---|---|---|
| Internal dashboard | `WAG_Dashboard` (Frontend_Repository) | JWT-authenticated `/api/*` |
| Scout field form | `Scout-Frontend` | `POST /api/warehouses/scout` (empID token) |
| Partner systems | — | `POST /api/staging/ingest` (shared secret) |

---

## Table of contents

- [Architecture](#architecture)
- [Key design decisions](#key-design-decisions)
- [The staging pipeline](#the-staging-pipeline)
- [Authentication & authorization](#authentication--authorization)
- [Project layout](#project-layout)
- [API surface](#api-surface)
- [Data model](#data-model)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Testing](#testing)
- [Deployment](#deployment)
- [Operational notes & gotchas](#operational-notes--gotchas)

---

## Architecture

Four layers, strictly one-directional. Nothing skips a layer, and nothing calls upward.

```
HTTP  ─▶  Routes  ─▶  Middleware  ─▶  Controllers  ─▶  Services  ─▶  Models  ─▶  Prisma  ─▶  Postgres
                      (auth, rate      (HTTP only)     (business      (persistence,
                       limit, Zod                       rules)         Prisma calls)
                       validation,
                       audit)
```

| Layer | Responsibility | May not |
|---|---|---|
| **Routes** (`src/routes/`) | URL → middleware chain → controller method | contain logic |
| **Middleware** (`src/middleware/`) | Auth, capability gates, Zod validation, sanitization, audit helper, error translation | know about domain entities |
| **Controllers** (`src/controllers/`) | Parse request, call one service, shape the response, queue an audit entry | touch Prisma |
| **Services** (`src/services/`) | Business rules, orchestration, cross-entity workflows | speak HTTP (`req`/`res`) |
| **Models** (`src/models/`) | Prisma queries, DB error translation | contain business rules |
| **Validators** (`src/validators/`) | Zod schemas — the contract for every inbound payload | — |

Base classes (`baseController`, `baseService`, `baseModel`, `baseValidator`) carry the shared
mechanics — `sendSuccess`/`sendCreated`, `asyncHandler`, `executeOperation`, `handleDatabaseError`
— so concrete classes stay small and consistent.

### Dependency injection

`src/container.js` wires the whole graph at import time. Models and services are
**singletons** (stateless, and a single `PrismaClient` means a single connection pool);
controllers are **transient**.

```js
const container = require('./container');
const warehouseController = container.resolve('warehouseController');
```

Why a hand-rolled container rather than a DI library: the graph is ~20 nodes and entirely
static. The container buys testability (swap a model for a stub in one place) without a
dependency or a decorator/metadata build step.

---

## Key design decisions

### 1. Review-before-publish, not flags-on-live-rows
Untrusted inbound data used to be written straight into `Warehouse` with
`wogVerified:false, visibility:false`, which meant every read query had to remember to
filter it out. Inbound submissions now go to a separate `StagedWarehouse` table. Master
data is trusted by construction. See [The staging pipeline](#the-staging-pipeline).

### 2. Accept liberally at the edge, validate strictly at promotion
The staging table mirrors every `Warehouse` column but **all nullable**, so a messy partner
payload can never bounce at ingest. Strict `createWarehouseSchema` validation runs at
*approval* time instead, where a human can fix the flagged fields. Scout keeps its strict
gate at the door as well, because the Scout form wants field-level errors while the user is
still standing in the warehouse.

### 3. Claim-first promotion, not interactive transactions
Promotion (`stagedWarehouseModel.promote`) does **not** use `prisma.$transaction(async tx => …)`.
Interactive transactions are unreliable through the Supabase connection pooler (they fail
with `P2028`). Instead:

1. An atomic `updateMany({ where: { id, reviewStatus: 'PENDING' }, data: { reviewStatus: 'APPROVED' } })`
   claims the row. Only one caller can win, so a double-click can never create two warehouses.
2. The `Warehouse` insert runs. If it throws, the claim is **compensated** back to `PENDING`
   so the row returns to the queue.
3. The staged row is linked to the new `warehouseId`, and an audit entry is written.

Same pattern in `reopen()`. This is a deliberate trade of transactional atomicity for
pooler compatibility, with compensation covering the failure path.

### 4. Capabilities, not roles
Access is a set of independent booleans on `VerifiedNumber` (`dashboardAccess`,
`callDashboardAccess`, `reviewerAccess`, `adminAccess`) rather than a single role enum, so a
user can hold any combination and granting access is one column flip. See
[Authentication & authorization](#authentication--authorization).

### 5. Contact numbers are redacted by default and revealed with a stated reason
`warehouseService.transformWarehouse` strips `contactNumber` from every list/detail
response. Revealing it requires a separate call to `GET /api/warehouses/:id/contact-number`
with a `reason` that is **validated server-side** (`validateContactReveal`) — not just in the
UI — and stored on the audit entry. Hitting the API directly cannot skip the reason.

### 6. Audit logging never blocks or breaks a request
`createAuditMiddleware` attaches `req.audit(action, entity, entityId, context, metadata)`,
which only *queues*. Entries flush on `res.on('finish')`, fire-and-forget, and
`AuditLogService.log()` swallows its own errors. Audit logging can slow nothing down and
can break nothing.

### 7. Direct-to-R2 uploads
The API never proxies file bytes. It issues a short-lived presigned `PutObject` URL
(default 360s) and the browser `PUT`s straight to Cloudflare R2. Keeps the API stateless
and its memory flat regardless of a 50 MB site video.

### 8. Everything fails closed
- Missing `STAGING_INGEST_SECRET` → the ingest endpoint returns **503**, never "allow all".
- Capability lookup errors or a missing `VerifiedNumber` row → **no** capabilities.
- Auto-approve setting unreadable → the submission stays `PENDING`.
- Webhook secret compared with `crypto.timingSafeEqual` over SHA-256 digests, so length
  mismatches can't throw and timing leaks nothing; missing header and wrong secret return
  an identical 401.

### 9. Best-effort enrichment never blocks a submission
Coordinates are auto-filled from the submission's Google Maps URL
(`utils/googleMaps` — warms a browser-like session, follows share/short links, extracts
lat/lng). Zone is derived server-side from the Indian state (`utils/deriveZone`, falls back
to `MISC`). WhatsApp review notifications go through Gupshup. All three are wrapped so a
failure degrades the record rather than rejecting it.

### 10. Media dual-write
Media lives in the `media` JSONB column as `{ images, videos, docs }`, but the legacy
comma-separated `photos` string column is still written alongside it
(`utils/mediaUtils.photosToMedia` / `mediaToPhotos`) for consumers not yet migrated.

---

## The staging pipeline

```
  Scout form            Dashboard form          Partner webhook
  (strict Zod)          (strict Zod)            (relaxed ingestSchema)
  POST /warehouses/     POST /warehouses        POST /staging/ingest
       scout                                    x-webhook-secret
  empID token           JWT                     shared secret
        │                     │                       │
        └─────────────────────┴───────────────────────┘
                              ▼
                   toStagedRow()  ── forces uploadedBy, wogVerified:false,
                              │      visibility:false (a caller can never self-approve)
                              │   ── derives zone from state (if not supplied)
                              │   ── geocodes googleLocation → lat/lng (best effort)
                              ▼
                   StagedWarehouse (PENDING)
                              │
              ┌───────────────┴─────────────────┐
              │ autopilot ON?   → auto-approve  │  (DB setting, admin-togglable;
              │ validation fails → stays PENDING│   reviewer recorded as
              └───────────────┬─────────────────┘   "system:auto-approve")
                              ▼
              Review panel — GET/PATCH /api/staging
              list → edit (stays PENDING, diffed field-by-field) → approve / reject
                              │
      approve ────────────────┤                 reject ──▶ REJECTED + reason
                              ▼                            (Gupshup notifies submitter)
      strict createWarehouseSchema
                              ▼
      claim-first promote → Warehouse + WarehouseData (visibility: true)
                              ▼
      staged row APPROVED, linked via warehouseId
```

Notable properties:

- **`reopen`** moves an `APPROVED`/`REJECTED` row back to `PENDING`. Reopening an approved
  row also *deletes* the promoted `Warehouse` (cascading `WarehouseData`), so revoking an
  approval actually pulls it off the live list.
- **`warehouseDeleted`** is computed at read time with one batched existence query rather
  than stored. `warehouseId` has no FK, so a warehouse deleted by any route — API, manual
  SQL, future code — is reflected in the review panel with no flag to keep in sync.
- **Approval sets `visibility: true` but never `wogVerified`.** Verification is a separate
  trust signal with its own process.
- The list query omits the heavy `rawPayload`/`flags`/`reviewMeta` JSON columns; fetch a
  single row when the full immutable snapshot is needed.

Design spec: `docs/STAGING_VALIDATION_LAYER.md` (written as a proposal; now implemented).

---

## Authentication & authorization

Three independent ingress paths, deliberately kept separate because they have different
threat models:

| Path | Mechanism | Used by | Rate limit |
|---|---|---|---|
| Dashboard | Google OAuth → HS256 JWT (`Authorization: Bearer`) | Internal users | — |
| Scout | `empID` looked up in `VerifiedNumber` (body `uploadedBy` or `x-scout-token`) | Field scouts | 15/h submit, 200/h presign |
| Webhook | Shared secret in `x-webhook-secret` | Partner systems | 500/h |

### OAuth flow

The backend, not the frontend, is the OAuth client. Google redirects to
`GET /auth/google/callback` on the **backend**, which exchanges the code, enforces the
`ALLOWED_DOMAIN` (`wareongo.com`), mints a JWT, and redirects back to whichever frontend
started the flow. Only one redirect URI is ever registered with Google, so adding a
frontend needs no Google Console change — see `docs/FRONTEND_INTEGRATION_GUIDE.md`. The
auth router is mounted at both `/auth` and `/api/auth`: `/auth` keeps the registered
redirect URI stable, `/api/auth` gives the frontend one consistent `/api` prefix.

JWTs are HS256, 24h by default, carry `iss: warehouse-api` / `aud: warehouse-frontend`, and
`JWT_SECRET` must be ≥32 chars (enforced at boot by `validateAuthConfig`).

### Capabilities

`utils/access.js` resolves an email to `{ DASHBOARD, CALL_DASHBOARD, REVIEW, ADMIN }`:

```js
router.use(authMiddleware.authenticateJWT, authMiddleware.requireAccess(CAPS.REVIEW));
```

- Each capability maps to a boolean column on `VerifiedNumber` (`CAP_COLUMN`).
- Emails in the `ADMIN_EMAILS` env allowlist, and users with `adminAccess`, implicitly hold
  **every** capability — admin is a master override that can never be locked out by a
  missing flag.
- `isAdmin` is re-evaluated from env on **every request**, so changing the allowlist doesn't
  require existing users to re-login.
- Lookup is case-insensitive (OAuth emails are lowercase; stored emails may not be).
- `requireAccess` also stashes `req.user.capabilities` / `isAdmin` / `isReviewer` for
  downstream handlers.

Adding a service: add a `CAPS` key, a `CAP_COLUMN` entry + Prisma column, and gate the
routes. No other call site changes.

Capability layering is per-route where it differs: `/api/staging` is reviewer-gated overall
but `DELETE` layers `requireAdmin` on top; `/api/micro-markets` is reviewer-gated *including*
`DELETE`, because drawing and erasing polygons is the core reviewer workflow.

---

## Project layout

```
Backend_Repository/
├── index.js                     # entry point → src/app.js
├── src/
│   ├── app.js                   # Express bootstrap: CORS, parsers, audit, routes, error handler, shutdown
│   ├── container.js             # DI container — the full object graph
│   ├── routes/
│   │   ├── auth.js              # OAuth + token lifecycle (mounted at /auth and /api/auth)
│   │   ├── warehouse.js         # /api/warehouses — CRUD, search, coords, visit notes, uploads, scout
│   │   ├── staging.js           # /api/staging — public ingest + reviewer-gated review API
│   │   ├── microMarkets.js      # /api/micro-markets — reviewer-drawn polygons
│   │   └── verifiedNumbers.js   # /api/verified-numbers — POC lookup
│   ├── controllers/             # HTTP layer
│   ├── services/                # business logic
│   │   ├── warehouseService.js  # filters, pagination, redaction, business rules
│   │   ├── stagingService.js    # the review pipeline
│   │   ├── fileUploadService.js # presigned R2 URLs
│   │   ├── googleOAuthService.js / jwtService.js
│   │   ├── gupshupService.js    # WhatsApp review notifications (feature-flagged)
│   │   ├── settingsService.js   # runtime toggles (autopilot)
│   │   └── auditLogService.js / microMarketService.js / visitNoteService.js
│   ├── models/                  # Prisma access
│   ├── validators/              # Zod schemas
│   ├── middleware/              # auth, scout, webhook, validation, audit, errorHandler
│   └── utils/
│       ├── access.js            # capability resolution
│       ├── admin.js             # ADMIN_EMAILS allowlist
│       ├── database.js          # singleton PrismaClient + health check
│       ├── s3Client.js          # singleton R2 client
│       ├── googleMaps/          # URL → lat/lng (session warm-up + extractor)
│       ├── deriveZone.js        # Indian state → NORTH/WEST/SOUTH/EAST/CENTRAL/MISC
│       ├── mediaUtils.js        # media JSONB ⇄ legacy photos CSV
│       └── empIdGenerator.js    # collision-checked 6-char employee IDs
├── prisma/schema.prisma
├── tests/                       # Jest + Supertest
├── docs/                        # staging spec, frontend integration, Docker/ECR setup
├── scripts/                     # backfillMicroMarkets.js
└── routes/warehouse.js          # ⚠ legacy, NOT mounted — superseded by src/routes/warehouse.js
```

> `routes/` at the repo root is pre-refactor dead code kept for reference. `src/app.js`
> mounts `src/routes/*` only.

---

## API surface

All responses are `{ success, data, ... }` on the happy path; errors are normalized by
`ErrorHandler` to `{ error, code, details?, timestamp, path }`.

### Health

| Method | Path | Notes |
|---|---|---|
| `GET` | `/` | Version banner |
| `GET` | `/health` | 200 / 503 with DB connectivity |
| `GET` | `/auth/health` | OAuth config check |

### Auth — `/auth` and `/api/auth`

| Method | Path | Notes |
|---|---|---|
| `GET` | `/google` | Returns the Google authorization URL |
| `GET`/`POST` | `/google/callback` | Code exchange → JWT |
| `POST` | `/refresh` | New token from a valid one |
| `POST` | `/logout` | Client-side signal (JWTs are stateless) |
| `GET` | `/me` | Current user (JWT required) |

### Warehouses — `/api/warehouses` (JWT unless noted)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/` | Paginated + filtered list. `?all=true` returns the full filtered set |
| `GET` | `/search` | Legacy criteria search |
| `GET` | `/statistics` | Aggregates |
| `GET` | `/coordinates` | `{ id, lat, lng, availability }` for **all** matches, unpaginated (map) |
| `GET` | `/:id` | Single warehouse (contact number redacted) |
| `GET` | `/:id/contact-number` | Reveal — **requires a validated `reason`**, audited |
| `POST` | `/` | Create → goes to **staging**, not straight to master |
| `PUT` | `/:id` | Update a master warehouse |
| `DELETE` | `/:id` | Admin only |
| `POST` | `/scout` | **No JWT** — empID token, rate-limited, → staging |
| `GET`/`POST` | `/:id/visit-notes` | Site-visit log |
| `PUT`/`DELETE` | `/:id/visit-notes/:noteId` | Delete is admin only |
| `POST` | `/presigned-url`, `/presigned-urls/batch` | R2 upload URLs |
| `POST` | `/scout/presigned-url` | **No JWT** — empID token, higher rate cap |
| `GET`/`POST`/`DELETE` | `/files/:fileName…` | Info / validate / delete (delete is admin only) |

Supported list filters: `search`, `ids`, `city`, `state`, `zone`, `warehouseType`,
`warehouseOwnerType`, `availability`, `isBroker`, `uploadedBy`, `landType`, `visibility`,
`fireNoc`, `minArea`/`maxArea`, `minRate`/`maxRate`, plus `page`, `limit` (max 100),
`sortBy`, `sortOrder`, `all`.

Two filters can't be expressed directly in a Prisma `where`: **area** (`totalSpaceSqft` is
`Int[]`) and **budget** (`ratePerSqft` is a `String`). Those run a raw id pre-query
(`findIdsByNumericRange`) whose result is intersected via `where.id.in`. `resolveWhere()` is
shared by the list and the coordinates endpoint so the map and the list can never disagree.

### Staging — `/api/staging`

| Method | Path | Auth |
|---|---|---|
| `POST` | `/ingest` | **Webhook secret** (not JWT) — registered before the review gate |
| `GET` | `/` | Reviewer |
| `GET` | `/:id` | Reviewer |
| `PATCH` | `/:id` | Reviewer — edits keep the row `PENDING` |
| `POST` | `/:id/approve` \| `/reject` \| `/reopen` | Reviewer |
| `DELETE` | `/:id` | **Admin** |
| `GET`/`PATCH` | `/settings/auto-approve` | Read: reviewer · Write: admin |

### Micro-markets — `/api/micro-markets` (reviewer)

`GET` returns a GeoJSON `FeatureCollection`; `POST`/`PUT`/`DELETE` manage reviewer-drawn
polygons. `DELETE` is intentionally *not* admin-gated.

### Verified numbers — `/api/verified-numbers` (any authenticated user)

Read-only WareOnGo POC list (name + number) for pickers.

---

## Data model

The schema is shared with other WareOnGo systems (CRM sync, WhatsApp agent, ticketing), so
`prisma/schema.prisma` contains more models than this API touches. The ones that matter here:

| Model | Role |
|---|---|
| `Warehouse` | Master record. Trigram GIN indexes on `address`/`compliances`, GIN on `totalSpaceSqft` |
| `WarehouseData` | 1:1 extension — geo, fire NOC, land type, power, pollution zone. Cascades on delete. Carries a pgvector `embedding` column |
| `StagedWarehouse` | Staging mirror — every `Warehouse` + `WarehouseData` field, all nullable, flattened |
| `VerifiedNumber` | Identity + capability flags + `empID` (scout token) |
| `AuditLog` | Append-only action log, indexed by entity/user/action/time |
| `AppSetting` | Runtime toggles, keyed `(application, key)` with a JSONB value — e.g. `dashboard/auto_approve_submissions` |
| `MicroMarket` | Reviewer-drawn polygon (`geometry` JSONB) |
| `WarehouseVisitNote` | Site-visit log, client feedback vs POC feedback |

`StagingService.WAREHOUSE_DATA_FIELDS` is the single source of truth for the flat ⇄ nested
split, and a drift test guards it against schema changes.

---

## Getting started

```bash
git clone https://github.com/WareOnGo/Dashboard_Backend.git
cd Dashboard_Backend
npm install                 # postinstall runs `prisma generate`
cp .env.example .env        # then fill it in
npx prisma db pull          # sync the schema from the live DB (see gotchas)
npx prisma generate
npm run dev                 # nodemon on :3001
```

Verify: `curl localhost:3001/health`

```bash
npm start          # production
npm test           # Jest
npm run test:ci    # Jest + coverage (what CI runs)
npx prisma studio  # DB browser
```

---

## Environment variables

Full list with commentary in `.env.example`.

| Group | Variables | Notes |
|---|---|---|
| Server | `PORT`, `NODE_ENV`, `CORS_ORIGIN`, `FRONTEND_URL` | `CORS_ORIGIN` is comma-separated; localhost + the CloudFront origin are always allowed |
| Database | `DATABASE_URL` | Postgres / Supabase pooler |
| OAuth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Redirect URI points at the **backend** |
| JWT | `JWT_SECRET` (≥32 chars), `JWT_EXPIRES_IN` | Validated at boot |
| Access | `ALLOWED_DOMAIN`, `ADMIN_EMAILS` | Comma-separated allowlist; grants every capability |
| Storage | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL` | Validated when `FileUploadService` constructs |
| Ingest | `STAGING_INGEST_SECRET` | **Unset ⇒ ingest returns 503** |
| WhatsApp | `GUPSHUP_ENABLED`, `GUPSHUP_API_KEY`, `GUPSHUP_SOURCE`, `GUPSHUP_SRC_NAME`, `GUPSHUP_TEMPLATE_ID`, `GUPSHUP_APPROVE_COMMENT`, `GUPSHUP_ENDPOINT` | Off unless `GUPSHUP_ENABLED` is exactly `"true"` |

---

## Testing

Jest + Supertest, `testEnvironment: node`. DB and external services are mocked so CI needs
no live Postgres.

```
tests/
├── app.test.js                     # health, 404, error shape
├── routes/warehouse.test.js        # endpoint behaviour
├── services/stagingService.test.js # flat⇄nested mapping, promotion rules, drift guard
├── middleware/errorHandler.test.js
└── utils/{constants,deriveZone}.test.js
```

`src/app-test.js` and `src/routes/warehouse-test.js` are a DB-free app variant used by the
route tests, and are excluded from coverage.

CI (`.github/workflows/ci.yml`) runs `npm run test:ci` on Node 18.x and 20.x for every push
and PR to `main`, uploading coverage to Codecov.

---

## Deployment

`.github/workflows/deploy-ecr.yml`, on push to `main`:

```
test (Node 18 + 20) ──▶ docker build ──▶ push to ECR :latest ──▶ App Runner picks it up
```

Required repo secrets: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`,
`ECR_REPOSITORY`.

The image is `node:18-alpine`, installs with `npm ci --only=production`, and relies on
`postinstall → prisma generate`. `prisma/` is copied **before** `npm ci` so generation has a
schema to read.

`package.json` also declares `docker:build` / `docker:run` / `docker:up` / `docker:down` /
`docker:logs` / `deploy:ecr`, but these shell out to `scripts/docker-dev.sh` and
`scripts/deploy-ecr.sh` **which are not present in the repo** — they will fail until those
scripts are restored. Build and run the image directly in the meantime; the intended
workflow is described in `docs/DOCKER_DEPLOYMENT.md` and `docs/SETUP_GUIDE.md`.

`scripts/` currently holds one maintenance job: `backfillMicroMarkets.js`
(`npm run backfill:micromarkets`), which re-tags warehouses against the
reviewer-drawn polygons — needed with `--all` whenever a polygon is renamed or moved.

`SIGINT`/`SIGTERM`/`uncaughtException`/`unhandledRejection` all route through
`gracefulShutdown`, which disconnects Prisma before exiting.

---

## Operational notes & gotchas

- **Never `prisma db push` without pulling first.** The database is shared with other
  WareOnGo services and carries objects Prisma doesn't fully model (RLS policies, expression
  indexes, `vector` columns). Run `npx prisma db pull` first so a push can't drop them.
- **No interactive transactions.** `prisma.$transaction(async tx => …)` fails with `P2028`
  through the Supabase pooler. Use the claim-first + compensation pattern instead.
- **Adding a warehouse column** touches four places: `Warehouse` and `StagedWarehouse` in
  the schema, `warehouseValidator`, and — if it belongs to the nested extension —
  `StagingService.WAREHOUSE_DATA_FIELDS`. The drift test will tell you if you missed one.
- **CORS is partly hard-coded.** `src/app.js` pins the CloudFront origin and localhost dev
  ports alongside `CORS_ORIGIN`. A new frontend origin needs a code change here, not just
  an env var.
- **Rate limits are per-IP** (`express-rate-limit`, in-memory). Behind a load balancer this
  is per-instance, and it resets on deploy. It's a burst backstop, not a quota.
- **Autopilot is a live DB setting**, not an env var — an admin can flip it from the review
  panel and it takes effect on the next submission.
- **Gupshup is off by default.** Turning it on requires all of
  `API_KEY`/`SOURCE`/`SRC_NAME`/`TEMPLATE_ID`; otherwise sends are skipped with a warning
  rather than failing the approve/reject.

---

## License

ISC — see [LICENSE](LICENSE).
