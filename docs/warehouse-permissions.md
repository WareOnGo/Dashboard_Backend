# Warehouse permissions under Dashboard access

HRMS exposes four nested permissions on `VerifiedNumber`:

| Admin label | Column | Capability | Requires |
| --- | --- | --- | --- |
| View own warehouse entries | `viewOwnWarehouseEntries` | `WAREHOUSE_VIEW_OWN` | Dashboard |
| Edit own warehouse entries | `editOwnWarehouseEntries` | `WAREHOUSE_EDIT_OWN` | View own |
| View all warehouse entries | `viewAllWarehouseEntries` | `WAREHOUSE_VIEW_ALL` | View own |
| Edit all warehouse entries | `editAllWarehouseEntries` | `WAREHOUSE_EDIT_ALL` | Edit own and View all |

Enabling a permission enables its prerequisites. Disabling a permission clears
every dependent permission in the same roster transaction. Explicit false wins
if an API payload contains contradictory grants. Turning Dashboard back on
does not restore permissions cleared by a previous revocation. Changes include
the entire cascade in the audit diff and invalidate the existing capability cache.
Every warehouse request, including reads, resolves fresh permissions so a revocation
committed by another process applies to the next request. Other service reads retain
their existing 30-second cache. Active admins inherit all permissions, including environment admins;
inactive, missing, or ambiguous employee identities receive no access.

“Own” means an exact, case-insensitive match between the authenticated employee's
email and the warehouse's recorded `uploadedBy`. SQL wildcard characters in the
email are escaped. Legacy names, initials, missing attribution, and another
employee's email do not establish ownership. Those entries require all-access
until their attribution is corrected. Email changes do not transfer historical
warehouse ownership. Create records use the authenticated email; edits cannot
change `uploadedBy`.

Edit own also permits dashboard creation and uploads. Read-only users can view
and export the warehouses they can access. View all plus Edit own is valid and
does not permit editing other employees' entries. Direct dashboard deletion remains
admin-only. The Scout submission workflow and the separate staging Reviewer capability
keep their existing authorization rules. Reviewer grants still allow staging reads,
approval, and revocation of approved submissions, which removes the linked master
warehouse. Dashboard toggles therefore do not revoke a separate Reviewer grant.

Warehouse access applies to paginated and bulk lists, searches, totals, filter
options, map coordinates/GIS, direct details, contact reveals, image labels,
voice-note playback, visit notes, file metadata/validation, and every PPT/XLSX
export. Mixed permitted/forbidden export selections fail before generation.
Field-review assignments do not override warehouse access: queues, histories,
summaries, details, and responses respect the new grants. An assigned reviewer
who can view but cannot edit sees a read-only review. New assignments and reassignments
require permission to edit the specific warehouse; an admin can identify and reassign
existing reviews whose assignee has lost that permission.

Warehouse scope changes in the browser discard dashboard/map data and PPT/itinerary
previews, ignore late responses, and cancel pending downloads. This runs when the
authenticated user's capabilities refresh; open tabs do not receive pushed permission
updates. API authorization remains independent of that browser state. A request already
authorized before a revocation can still finish. Previously downloaded files and known
public photo/document URLs cannot be recalled by these toggles. Protecting the media
bytes themselves would require private storage and authorized download URLs.

## Rollout

Run this additive migration **before deploying the API that selects the new
columns**. Do not use a blanket `prisma db push` against the shared database.

```sh
npm run migrate:warehouse-permissions
npm run migrate:warehouse-permissions -- --apply
npx prisma generate
```

The first command reports a dry run. Apply adds each missing warehouse column with
a true default for all existing employee records, then sets the creation defaults
within the same transaction: Dashboard, View own, Edit own and View all are enabled;
Edit all is disabled. These defaults apply in both the admin API and database.
Explicit restrictions in an API create request override the defaults and cascade
normally. Other service permissions keep their existing defaults.

Repeating the migration updates defaults for future inserts without changing any
existing values, including Active, Dashboard, and later admin revocations. Rerun it
to upgrade a database that received the original default-off rollout. Editing an
existing employee never reapplies the creation defaults.

For this rollout, all four new columns were added and enabled for the 25 existing
employee records. The View all + Edit own creation defaults have also been applied
to the database, with all 25 existing permission sets verified unchanged.
Application deployment is separate from these database changes.

## Verification

The policy suite exhausts all 32 stored permission states and every nonempty partial
absent/false/true update combination, plus updates that leave permissions alone. Route tests exercise direct IDs, mixed
exports, malicious filters, immutable attribution, read-only writes, parent
revocations, and admin inheritance. Disposable PostgreSQL integration tests
verify backfill/defaults, reruns, transaction/audit behavior, literal identity
matching, and field-review restrictions. Frontend tests cover desktop/mobile
nesting, prerequisite cascades, failed saves, inactive/admin controls, read-only
actions, and clearing loaded rows after a view-scope downgrade.

The adversarial follow-up added regressions for cross-process revocation with a warm
capability cache, late export/itinerary responses, cancelled downloads, and assignee
eligibility. A real PostgreSQL check also caught the existing invalid `AVG(integer[])`
statistics query; it now averages each permitted warehouse's total area, excluding
empty/unknown area arrays. See [the review record](warehouse-permissions-adversarial-review.md).
