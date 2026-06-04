# Staging & Validation Layer — Design Spec

Status: **proposed** (not yet implemented). This document is the agreed design for a
review-before-publish layer for warehouse data arriving from the Scout frontend and
other external endpoints.

## Problem

Today, Scout submissions go **straight into the master `Warehouse` table**:

```
POST /api/warehouses/scout
  → verifyScoutToken
  → validateWarehouseCreate   (strict Zod — rejects imperfect data)
  → createScoutWarehouse
  → warehouseService.createWarehouse   → INSERT into master Warehouse
                                         (tagged wogVerified:false, visibility:false)
```

So "staging" is really just two boolean flags on live rows. Untrusted data is co-mingled
with trusted master data, and every read query must remember to filter it out. We also
reject imperfect submissions at the door instead of letting a human fix them.

## Goal

A dedicated **staging table** that holds inbound submissions from any source. A reviewer
lists, edits, approves, or rejects each entry in the dashboard. Only on approval does a
validated row get promoted into the master `Warehouse` table.

```
Scout / other endpoints
        │  (light shape check only — accept liberally)
        ▼
  StagedWarehouse (PENDING)
        │
        │  [reserved seam: AI/rules correction stage — see "Future" below]
        ▼
  Dashboard review queue:  list → edit → approve / reject
        │
   approve ──▶ strict Zod (createWarehouseSchema) ──▶ tx { Warehouse.create + staging.APPROVED + link warehouseId }
   reject  ──▶ staging.REJECTED + reason
```

## Decisions taken

- **Separate table, not a status flag on `Warehouse`.** Keeps the master table clean and
  trusted — no master read needs an "is this approved?" filter, so there is zero risk of
  unreviewed data leaking into the dashboard / PPT generator / search.
- **Full column mirror** of `Warehouse` (chosen over a generic Json payload), so reviewers
  edit typed fields. All mirrored columns are **nullable/relaxed** so ingest never bounces
  malformed data — it gets stored, not rejected.
- **Scout ingest keeps strict validation** (decided). The Scout endpoint continues to run
  `createWarehouseSchema` and return `400` with field-level issues, because the Scout
  frontend (`Scout_Frontend/src/utils/errorHandler.js`) depends on that error UX. Staging
  is the **human review/correction gate**, not a relaxation of Scout ingest. Only
  uncontrolled third-party endpoints (`/api/staging/ingest`) get relaxed accept-and-store.
- **Re-validate at promotion.** On approve, run `createWarehouseSchema` again on the
  (possibly edited) row. On failure, return the Zod errors and leave the row `IN_REVIEW`;
  on success, promote.
- **Review/approve is admin-only** (decided) — reuse `authMiddleware.requireAdmin`. A
  dedicated `REVIEWER` role can be added later.
- **Review UI lives in `Frontend_Repository`** (the existing authenticated dashboard).

### Promotion semantics (decided)

When an approved row is inserted into master `Warehouse`:
- `visibility` → **`true`** — visibility is **coupled to approval**: approved = not hidden.
- `wogVerified` → **untouched by approval**. It is a *separate* trust signal with its own
  process, kept independent of review/approval. It flows through from the staged row, which
  is forced to `false` at ingest; a separate WOG-verification flow sets it on master rows.
- `uploadedBy` → **the original scout/source** is preserved. The approver is recorded
  separately via the staging row's `reviewedBy` and the `APPROVE` audit entry.
- **Promotion reuses existing code paths** — `warehouseService.createWarehouse`, which
  already runs strict validation, business rules, the `photos → media` double-write, and
  the nested `WarehouseData` create.

## Compatibility / non-breaking guarantees

- **Migration is purely additive**: creates only the `StagedWarehouse` table and
  `StagingStatus` enum. No `ALTER` on `Warehouse`, `WarehouseData`, or any existing table.
  `warehouseId` is a soft reference (no FK) so the `Warehouse` model is not touched at all.
- **All submissions are staged — Scout and dashboard alike.** Both `POST /api/warehouses`
  (authenticated dashboard, JWT) and `POST /api/warehouses/scout` are redirected to staging
  (`source` `DASHBOARD` / `SCOUT`). Every inbound warehouse now gets the same review
  scrutiny; the only path into master `Warehouse` is approval. (This reverses the earlier
  "dashboard unchanged" stance — intentional.)
- **No existing endpoint changes behavior until deploy.** The new table is unused by
  existing code; the redirects and review API ship together at deploy time.
- **Intended post-deploy change:** newly submitted warehouses (Scout *or* dashboard) no
  longer appear in the master list immediately — they wait in the staging queue until a
  reviewer approves them. On approval they become visible (`visibility=true`).

## Schema

`StagedWarehouse` mirrors every `Warehouse` column **and** the nested `WarehouseData`
fields (latitude, longitude, fireNocAvailable, …), because a warehouse create expects the
shape `{ ...warehouseFields, warehouseData: { ... } }`. A flat mirror that omits the
`WarehouseData` fields would silently drop geo/extra data on promotion.

```prisma
model StagedWarehouse {
  id              String         @id @default(uuid())

  // --- pipeline / review metadata ---
  reviewStatus    StagingStatus  @default(PENDING) // named reviewStatus to avoid colliding with the mirrored `status` column
  source          String                          // 'SCOUT' | 'PARTNER_API' | ...
  submittedBy     String                          // scout email / api key id
  submittedAt     DateTime       @default(now())
  reviewedBy      String?
  reviewedAt      DateTime?
  rejectionReason String?
  warehouseId     Int?                            // SOFT reference to promoted master row (no Prisma @relation,
                                                  // no FK constraint) — keeps the migration purely additive
                                                  // and zero-touch on the Warehouse model/table.

  // --- raw snapshot + future correction hooks (reserved; null for now) ---
  rawPayload      Json?                           // immutable copy of the submission as received
  flags           Json?                           // [{field, severity, message, source, suggestedValue?}]
  reviewMeta      Json?                           // AI provenance: model, confidence, runAt

  // --- mirrored Warehouse columns (ALL nullable) ---
  // warehouseType, address, city, state, zone, contactPerson, contactNumber,
  // totalSpaceSqft, ratePerSqft, compliances, photos, ... (full set)

  // --- mirrored WarehouseData columns (ALL nullable) ---
  // latitude, longitude, fireNocAvailable, landType, powerKva, ...

  @@index([reviewStatus, submittedAt])
}

enum StagingStatus {
  PENDING
  IN_REVIEW
  APPROVED
  REJECTED
  // headroom: FLAGGED / NEEDS_CORRECTION can be added later without renaming the above
}
```

`rawPayload`, `flags`, `reviewMeta` are added now and left null — cheap today, painful to
add mid-stream once the AI correction middleware exists.

## API (Backend, consumed by the dashboard)

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/warehouses/scout` (redirected) | Scout ingest → write `PENDING` staging row instead of master |
| POST | `/api/staging/ingest` | Generic external **webhook** ingest. Auth: shared secret in `x-webhook-secret` (env `STAGING_INGEST_SECRET`; unset ⇒ 503). Accept-and-store (relaxed `ingestSchema`); tags `source=PARTNER_API` |
| GET  | `/api/staging?status=PENDING` | Review queue list (paginated; default cap 100, omits `rawPayload`/`flags`/`reviewMeta`) |
| GET  | `/api/staging/:id` | Full staged row |
| PATCH | `/api/staging/:id` | Reviewer edits any mirrored field (row stays `PENDING`) |
| POST | `/api/staging/:id/approve` | Strict-validate → promote to `Warehouse` → `APPROVED` |
| POST | `/api/staging/:id/reject` | `REJECTED` + reason |
| POST | `/api/staging/:id/reopen` | Move `APPROVED`/`REJECTED` → `PENDING` (revoke / un-reject) |
| DELETE | `/api/staging/:id` | Delete the staging record (a promoted master warehouse is left intact) |

All review actions call `req.audit(...)` to preserve the existing audit trail.

**Status model.** Only `PENDING`, `APPROVED`, `REJECTED` are used. `IN_REVIEW` is **retired**
— editing no longer flips to it; it remains in the DB enum only to avoid a risky Postgres
enum rebuild (unused). Transitions: `PENDING → APPROVED|REJECTED`; `APPROVED|REJECTED →
PENDING` via **reopen**. Reopening an `APPROVED` row also **deletes the master `Warehouse`**
it was promoted to (cascading `WarehouseData`), pulling it back out of the live list.
"Accept a rejected one" = reopen → approve.

## Audit & history

Two layers, reusing the existing `AuditLog` infrastructure (`req.audit(...)`).

**Layer 1 — append-only trail in `AuditLog`**, new entity `"staged_warehouse"`:

| Action | When | Actor | Metadata |
|--------|------|-------|----------|
| `CREATE` | ingest | scout / source | `{ source, scoutEmpid }` |
| `UPDATE` | reviewer edits a staged row | reviewer (JWT) | `{ changes: [{field, from, to}] }` — real before/after diff |
| `APPROVE` | promotion to master | reviewer (JWT) | `{ stagedId, warehouseId, editedFieldCount }` |
| `REJECT` | rejection | reviewer (JWT) | `{ stagedId, rejectionReason }` |

The `UPDATE` diff stores before/after **values**, not just field names (the existing
warehouse update audit only stores `Object.keys(req.body)` — insufficient for a review
workflow's "what changed").

**Layer 2 — durable provenance on the staging row**: `submittedBy/submittedAt`,
`reviewedBy/reviewedAt`, `rejectionReason`, and the immutable `rawPayload`. "Who approved
this and what did it originally look like" is answerable directly from the record; the
original-vs-final diff is reconstructable from `rawPayload` vs the promoted row.

**Durability of the trust-critical entry:** the existing audit path is fire-and-forget
(flushed on `res.on('finish')`, errors swallowed). That stays for `CREATE`/`UPDATE`/READ.
The `APPROVE`/`REJECT` audit entry is instead written **synchronously (awaited) immediately
after the atomic status claim**, inside the model's `promote`/`reject` methods — so it is
tied to the same request that performs the promotion rather than deferred to response-finish.

Implementation note: interactive Prisma transactions proved unreliable through the Supabase
pooler (`P2028`), so promotion uses a **claim-first + compensation** pattern instead of a
single DB transaction: a single atomic `updateMany` claims the row (`PENDING →
APPROVED`) — which alone guarantees no duplicate Warehouse can be created — then the
Warehouse is inserted, the row is linked, and the audit is written. If the insert fails the
claim is reverted to `PENDING` (so it returns to the queue and can be retried). The audit
write is best-effort (logged on failure) so it can never roll back a valid promotion.

## Drift mitigation (cost of a full mirror)

A full mirror means adding a `Warehouse` column requires touching the staging model too.
To keep that a known, one-line change:

- Keep a single `STAGED_TO_WAREHOUSE` field map in one module (the promotion mapper).
- Add a test asserting every field in `createWarehouseSchema` exists on `StagedWarehouse`,
  so a forgotten mirror column fails CI instead of silently dropping data.

## Future: AI / rules correction middleware (NOT in scope now)

Designed-for, not built. It will sit as a **stage between ingest and human review** and is
a pure addition — no migration of the core tables, no change to ingest or promote logic:

- Reads the staged row (and `rawPayload` as ground truth).
- Writes `flags` (flagged fields, severity, suggested values) and `reviewMeta` (provenance).
- May propose edits without applying them; the human reviewer accepts/rejects in the UI.
- May move a row to a future `FLAGGED` / `NEEDS_CORRECTION` status.

Because the approve/reject service reads only the *current* staged state (not how it got
there), inserting this stage requires no changes to the rest of the pipeline.

## Design defaults for secondary concerns

Handled in the build with these defaults unless overridden:

- **Double-approval guard.** Promotion runs in a transaction with an optimistic status
  check (`WHERE status IN (PENDING, IN_REVIEW)`); a second concurrent approve no-ops.
- **Scout frontend contract.** After redirect, the Scout submit returns a staging row
  (uuid id), not a master warehouse. The frontend success copy changes from "created" to
  "submitted for review" — a small coordinated frontend change ships with this.
- **Media lifecycle.** Scout images are uploaded to S3 (`scout/` prefix) before submission,
  so media exists at ingest regardless of outcome. A periodic sweep removes S3 objects tied
  to `REJECTED` rows older than N days to avoid orphans.
- **Reject lifecycle.** `REJECTED` is non-terminal for the data: a reviewer (or resubmission)
  can reopen/clone a rejected row rather than losing it. (Final state model TBD in Phase 2.)
- **Existing scout rows in master** (`wogVerified:false, visibility:false`) are left as-is;
  no backfill into staging.

## Open questions — need confirmation (outside this repo)

- **Geocoding / embedding pipeline.** No geocode/embedding/cron code exists in `src`, but the
  schema has `WarehouseData.embedding` (vector), `GeocodeAttempt`, `googlemapscrapejobs`,
  `CronRunLog` — so an external process populates them, presumably by scanning `Warehouse`.
  **Confirm that pipeline triggers on the master insert (promotion)**, so approved warehouses
  still get geocoded/embedded. Staged rows are naturally excluded until promoted.
- ~~**"Other endpoints outside this directory"**~~ — **resolved (Phase 4 built).** These are
  **warehouse-shaped** (so the full-column mirror fits and `toStagedRow` is reused) and arrive
  via a **webhook authenticated by a shared secret** in `x-webhook-secret` (env
  `STAGING_INGEST_SECRET`, constant-time compared, fails closed with 503 when unset).
  Ingest is **accept-and-store** (relaxed `ingestSchema`); the existing approve path
  re-validates strictly. Non-warehouse sources (enquiries/leads) remain out of scope —
  they'd need a different staging target.

## Phases

1. **Backend foundation** ✅ *(done)* — `StagedWarehouse` model + `StagingStatus` enum (with
   reserved columns); applied to prod additively via `db pull` → `db push` (verified
   `CREATE`-only, Warehouse untouched at 1,692 rows). Scout ingest (`createScoutWarehouse`)
   redirected to `StagingService` → writes a `PENDING` staging row; `rawPayload` snapshotted
   at ingest; strict `createWarehouseSchema` validation retained on the route. The
   authenticated dashboard create (`createWarehouse`) is likewise redirected to staging
   (`source=DASHBOARD`) so all submissions get review scrutiny. `wogVerified`/`visibility`
   are forced `false` at ingest.
   New files: `models/stagedWarehouseModel.js`, `services/stagingService.js` (+ container wiring).
2. **Review API** ✅ *(done)* — admin-only (`authenticateJWT` + `requireAdmin`) routes under
   `/api/staging`: `GET /` (list/filter by `reviewStatus`, paginated), `GET /:id`,
   `PATCH /:id` (edit + field-level diff audit; row stays `PENDING`), `POST /:id/approve`
   (re-validate with `createWarehouseSchema` → claim-first promote to `Warehouse`,
   `visibility=true`, `wogVerified` left untouched, original `uploadedBy` preserved),
   `POST /:id/reject` (reason + audit). Double-approval blocked by the atomic claim (409).
   Each card shows a provenance strip (submitted-by; approved/rejected-by + when + reason +
   published warehouse #); the read-only view modal shows a full status banner with the same.
   Toolbar consolidated (status tabs + search + filters + count + refresh in one bar).
   New files: `controllers/stagingController.js`, `routes/staging.js`,
   `validators/stagingValidator.js`; model gained `updateStaged`/`promote`/`reject`;
   service gained list/get/edit/approve/reject + the `WAREHOUSE_DATA_FIELDS` map.
   Tests: `tests/services/stagingService.test.js` (mapping + mirror-drift guard).
3. **Dashboard review queue** ✅ *(done)* — in `Frontend_Repository`: admin-only `/review`
   route + `ReviewQueue.jsx` that reuses the dashboard's **exact** card grid + filters.
   Extracted shared, single-source pieces used by BOTH dashboard and review:
   `hooks/useWarehouseFilters.js` (all filter state + logic) and `WarehouseFilterBar.jsx`
   (the desktop filter panel); `CardView` gained an optional `getCardProps` passthrough and
   `SimpleWarehouseCard` gained backward-compatible `idLabel`/`statusContent`/`actions`
   overrides. The review page renders `CardView` (same `SimpleWarehouseCard`), the shared
   filter bar + search/toggle, and a review-status `Segmented`, all inside the same outer
   `Card` + padding wrapper as the dashboard so card sizing is identical. Each card has a
   single **"Review"** button. A `PENDING` row opens the editable **`WarehouseForm`** modal
   (staged row mapped to nested `warehouseData`) → `updateStaged`, with **Accept/Reject** in
   its sticky footer (via a new optional `reviewActions` prop). A finalized (`APPROVED`/
   `REJECTED`) row opens the **read-only `WarehouseDetailsModal`** instead, with a single
   **move-to-pending** action (Revoke / Move to Pending) in its footer (new optional
   `footerActions` prop). Approve surfaces server re-validation issues. "Review
   Queue" lives in the **navbar** (desktop `MobileHeader` + mobile `MobileNavigation`),
   admin-gated; a **Dashboard** nav link was added so users can return from `/review`.
   Dashboard refactor verified non-regressive via `eslint` + `vite build`.
   `warehouseService` gained `listStaged/getStaged/updateStaged/approveStaged/rejectStaged`.
   The dashboard create flow now treats a create as "submitted for review" (no longer adds
   to the master list). Verified with `eslint` + `vite build` (frontend vitest is outdated
   — not used).
4. **Generic ingest** ✅ *(done)* — `POST /api/staging/ingest` for non-Scout external
   sources (webhooks). Public route registered **above** the admin gate in `routes/staging.js`,
   authenticated by `verifyWebhookSecret` (shared secret in `x-webhook-secret` vs env
   `STAGING_INGEST_SECRET`; constant-time compare; **fails closed → 503** when unset;
   `401` on missing/wrong). Accept-and-store via the relaxed `ingestSchema`
   (`createWarehouseSchema.partial()`) → `StagingService.createIngestSubmission` reuses
   `toStagedRow` (forces `uploadedBy/wogVerified:false/visibility:false`, snapshots
   `rawPayload`), tagging `source=PARTNER_API` (renders as "External" in the existing review
   UI — no frontend change). `CREATE` audit logged with matching `source`. Hourly rate-limit
   backstop (500). New file: `middleware/webhookMiddleware.js`.
5. *(Later)* AI/rules correction middleware against the reserved seam above.
```
