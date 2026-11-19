# Field-review adversarial review

## Release preparation — 19 November 2026

The media-tracking migration was applied to the configured production database before the release push. Read-only verification confirmed that the installed helper/tracker bodies match the reviewed SQL, both tracking triggers are enabled, and the Warehouse trigger includes `media`. The migration's transactional checks confirmed RLS and backend access on all five tables, with no direct public/API access. Warehouse records were not rewritten.

The previous backend `main` deployment had failed three warehouse-route assertions that still expected the pre-cancellation active-flag filter. Those assertions now check the three active statuses; the existing PostgreSQL tests already verify that cancelled flags disappear from summaries. The complete backend CI gate subsequently passed **92 suites / 2,076 tests**, including its coverage thresholds. Application deployment remains a separate step from the database migration.

## Current review — 19 November 2026 (whole media section)

**Ready for production deployment of the reviewed code. No remaining blocking correctness or authorization defect was found in this pass.** This pass covers the complete field-review workflow on `field-review`, with particular attention to the new whole-media-section implementation. The frontend and backend changes remain local; this review performs no deployment or production-data write.

### Findings and fixes

| Priority | Finding | Correction and evidence |
| --- | --- | --- |
| P1 | Review uploads used ordinary overwrite-capable PUT URLs. Reusing the URL while it remained valid could change the object behind the same public URL after an employee submitted it or a reviewer inspected it, without advancing the gallery revision. | Review uploads now sign `If-None-Match: *` and return the required headers to the shared upload control. A real SDK signing test verifies that the condition is bound into the signature; the normal upload contract stays unchanged. Browser storage fixtures enforce the condition and the media flows upload successfully. [Cloudflare documents atomic conditional writes](https://developers.cloudflare.com/r2/api/s3/conditional-operations/). No live object overwrite was attempted. |
| P2 | An issued URL was treated as proof of a successful upload. Missing, empty, oversized or wrong-type objects could be submitted, and an object removed from storage after submission could still be approved. | Five failing PostgreSQL cases reproduced the problem. Before submission and an applying decision, the service checks server-issued object keys through HEAD for existence, matching MIME metadata and a nonzero size below 50 MB. Missing/invalid uploads cannot advance the flag; outages leave it available for retry. Checks run before warehouse locks, with bounded concurrency and a deadline. Tests cover reassignment and ordinary edits during the check, unauthorized callers, unchanged legacy galleries, and idempotent decision retries. |
| P2 | Earlier `photos` audit records were omitted from media history; the preview renderer also discarded available legacy values because those records were not complete gallery objects. | Failing backend and component cases reproduced this. Legacy `media`/`photos` records now appear with explicit recorded-field labels and their actual stored values/summaries. Complete tracked snapshots retain gallery previews. No missing historic gallery is fabricated. |
| P2 | One mobile protected-value retry check failed after a 503: a departing loading icon remained in the button’s accessible name even though the button was visually ready. The trace showed the icon hidden at zero width/opacity, still labeled `loading`. | Dialog confirmation, cancellation, reopening and reveal actions now keep explicit stable accessible names and busy states. A focused component case verifies the reveal control is disabled while pending and recoverable after failure. All six desktop/mobile cancellation and nested-retry scenarios passed after the fix. |

### Scope and complexity

- Only `media` is flaggable; individual image/video/document keys are rejected by both the request schema and service. Missing-image requests work with empty galleries.
- Corrections remain staged. Deletions, additions, replacements, reordering and change/revert sequences advance one media revision. All three conflict choices, required overwrite confirmation, stale employee/admin comparisons, return/cancel/reopen/reassign and atomic rollback are covered.
- Fresh account, View, assignment and Reviewer checks remain in place. A View-only assignee can respond and upload for the assigned open flag, while ordinary Edit remains governed by the existing permissions. No ordinary View/Edit permission or workflow lock was added.
- Storage checks use only object keys recorded by the server for the flag, never arbitrary URLs from a request. Ownership/status/live versions are rechecked in the final write transaction. Storage metadata does not verify file contents or scan for malware; this review does not claim otherwise.
- No extra table, workflow state, queue, worker or replacement View was introduced. The existing shared upload control and actual All details modal remain in use. Obsolete per-file flagging documentation was removed and cancellation documentation corrected.

### Verification

- **177 backend unit/API/permission/form tests passed.** These include real SDK signature generation, strict schemas, routes, storage validation, error handling and ordinary warehouse authorization.
- **160 PostgreSQL integration tests passed** against a disposable local database. These cover review state transitions, RLS, conflicts, locks, retries, rollback, metadata-check races and a migration rerun that preserves existing flags, gallery data and history.
- **171 distinct frontend component/form tests passed**, including the shared uploader, real All details view, ordinary warehouse create/edit payloads, ownership/role changes, legacy history and error recovery. The full component run passed 170 cases; the final focused run passed seven, including the additional busy-state regression.
- **37 distinct browser scenarios passed across the full runs and focused reruns:** 22 field-review/media workflows at 1280/390 px and 15 ordinary create/review/edit workflows including 320/390/1280 px. The first complete field-review run passed 21/22 and exposed the accessible-name issue above; all six affected dialog cases passed after the fix. The normal-form suite initially stopped before executing because its test-database variable was omitted; with the guarded local URL supplied, all 15 passed.
- Production frontend build, targeted lint, JavaScript syntax and whitespace checks passed.
- Read-only checks against the configured R2 endpoint verified object metadata access (a random absent key returned 404) and PUT preflight for the configured dashboard origin with `Content-Type` and `If-None-Match`. Reading the bucket configuration itself returned AccessDenied; the actual preflight succeeded, so no configuration change was needed. No object, bucket setting or production database row was changed.

### Release requirements and limits

1. Apply `node scripts/migrateFieldReview.js --apply` using the normal release process and verify its security result. The current media helper/tracker must be installed before enabling this API/UI; it is not installed on startup.
2. Deploy the backend, then the frontend. For any additional dashboard origin, verify the same storage preflight headers and metadata-read permission.
3. Perform the normal deployed upload/response/verification smoke test. Browser tests use real application/API/database code, with sign-in and object storage as fixtures. The review did not perform a live R2 upload or deploy these changes.

There is no production-volume load certification in this pass. Existing queue aggregation/pagination scale limits, manual refresh across browsers and bundle-size warnings remain documented follow-ups. Historical file previews depend on the storage objects remaining available; ordinary media removal detaches references and does not delete objects. These limits are distinct from the reproduced correctness defects fixed above.

## Previous review — 19 November 2026 (before media support)

**Ready for production deployment of the reviewed frontend/backend changes after the fixes below.** No remaining blocking correctness or authorization defect was found in this pass. This is not a production-volume load test or a sign-off on unrelated working-tree changes. Nothing was deployed by this review.

The current policy is documented in [field-review.md](field-review.md): reviewers manage reviews, assigned employees may respond without ordinary Edit permission, self-verification is allowed, and warehouse viewers can see active fields and their original reviewer notes. The historical assignment/Edit criteria below have been superseded by those explicit requirements.

| Priority | Reproduced defect | Fix and evidence |
| --- | --- | --- |
| P2 | After the modal refreshed, closing/reopening with the same older bundled card restored obsolete flags/notes. This occurs when the independent card-list refresh fails. A forbidden modal refresh could also be replaced by the cached notes on reopening. | Keep refresh results and errors associated with the warehouse, authorization scope and source bundle across modal visibility changes. A new warehouse, session/scope or bundle still invalidates them. Three failing component cases now pass; desktop and mobile browser tests deliberately fail the list refresh and confirm reopening does not restore a closed field or its note. |
| P2 | Closing while a bundled modal refresh was pending aborted the request and discarded its invalidation. Reopening treated the old bundle as current and never retried. | Retain pending invalidation across visibility changes, resume the refresh on reopening, and ignore the aborted response. The regression failed before the fix and passes afterward. |

Verification on the final code:

- 128 backend validation, API, warehouse-permission and error-handler tests passed.
- 99 isolated PostgreSQL integration tests passed, including role/assignment checks, concurrent decisions, idempotency, rollback and closing/reopening.
- 107 affected frontend component tests passed, including 26 highlight/notes cases and 81 dashboard, review-dialog and gallery cases.
- Six desktop/mobile browser workflows passed. These include ordinary viewers, the failed-list-refresh reproduction, loading status, reviewer/admin verification and employee responses without Edit access.
- All 76 registry fields have normal View bindings. Targeted lint, the production frontend build and whitespace checks passed.
- Read-only inspection of the configured database confirmed all five review tables and their RLS/access protections. Installed tracking function/trigger arguments match the checked-in migration, both triggers are enabled, and the active-review/active-field unique indexes and flag lookup index are valid. No migration or production-data write was performed. Several standalone connection attempts failed during inspection; the final fresh Prisma connection and query succeeded, and the running backend health check passed.

Remaining limits: the queue's existing grouping/distinct implementation has not been tested at high volume; cross-browser changes need refresh; requesting bundled reviews couples list availability to the review lookup. The bounded card query, explicit error/loading states and retained authorization checks make these deliberate limits rather than newly hidden failure modes. Existing bundle-size warnings remain.

## Historical review — 17 November 2026

The sections below record the earlier review and its evidence at that time. The current review above supersedes their deployment status and assignment-policy statements.

**Second adversarial pass: five additional defects reproduced and resolved locally.** These affected migration rollback, assignment eligibility, stale admin choices, account changes and Handover's saved alternate timing. The earlier Availability blocker also remains resolved. The fixes below are on `field-review` in both repositories; deployment and the separate performance follow-up remain outside this verification.

This review examined authorization, raw database access, concurrent edits, rollback, retries, history accuracy, input validation, asynchronous UI state and unnecessary workflow complexity. No deployed database or production data was used. Changes remain uncommitted.

## Second-pass findings

Each defect below was reproduced with a failing test before validating the correction. The assignment correction was integrated with the concurrent warehouse-permissions work; this pass verifies the resulting field-review behavior, not every unrelated change in the working tree.

| Priority | Reproduction and consequence | Resolution and regression evidence |
| --- | --- | --- |
| P1 | Migration permission verification ran **after** the DDL transaction committed. An API role inheriting table-owner access survived direct REVOKEs: the migration reported failure but left all five review tables and the tracking hooks installed. | Security verification now runs inside the same transaction as DDL. A PostgreSQL regression gives a temporary NOLOGIN `anon` role inherited owner access, confirms verification fails, and asserts that no review tables or tracking triggers remain. The temporary role and schema are removed afterward. |
| P2 | The assignment dropdown included employees who could not edit this warehouse. A read-only uploader could receive work, or an employee restricted to their own warehouses could be assigned another uploader's warehouse; the response API then correctly refused the work. | Setup, creation, detail and reassignment use the existing per-warehouse Edit permission. Uploader remains the default only when eligible. Revoked assignees remain identifiable and get a warning; admins can reassign. Adding flags to an existing inaccessible assignment is disabled with a link to change its assignee. PostgreSQL tests cover own-only and revoked permissions; a component test covers recovery from the summary. |
| P2 | Admin drafts were keyed only by flag revision. An ordinary warehouse edit changes the live revision without changing the flag. Closing/reopening could restore a previous choice, reason or confirmation against a different Current value. | Draft comparisons also track the live revision. A changed revision clears the admin choice, reason and confirmation while retaining employee text and its original baseline. Both reopening with a selected choice and reopening with confirmation already open have passing component regressions. The server still checks the live revision at commit. |
| P2 | Admin flagging setup/summary was reset only for warehouse and visibility changes. Switching accounts or losing the admin role could leave the summary and assignee information on screen; a late setup request could restore the previous account's state. | Creation state resets at email/role boundaries. Selection and summary require current admin access; request tokens ignore late setup/creation results after a session or preview change. Tests cover losing admin access with the summary open and an old setup completing after switching to another admin. |
| P2 | Handover comparisons display the selected timing type, but approval wrote all four stored properties. Applying Proposed or Baseline could silently replace a newer saved value for the other timing type that was absent from the comparison. | Approval applies the selected type and timing while preserving the latest stored values for the other type, under the existing lock. Final snapshots and audit events record the actual result. Four PostgreSQL regressions cover Fixed/Variable and Proposed/Baseline choices; the normal form's retained alternate values and optional timing behavior are preserved. |

No new workflow states, tables, background jobs or locks were added for these fixes. A flag still does not lock normal View/Edit while someone works through the review. The brief transaction lock at approval is needed for an atomic comparison and write; normal edits made while a response is pending trigger the existing comparison behavior.

## Resolved: Availability and its review date

**P1 — A review date could be approved against an availability answer that the employee did not verify.**

Before the fix, this was reproduced in a disposable PostgreSQL schema:

1. Warehouse Availability is **Yes** and Last reviewed is empty.
2. The employee responds to a Last reviewed flag with **16 November 2026**, explaining that the owner confirmed availability.
3. Another editor changes Availability to **No**. Last reviewed remains empty.
4. The review-date field's version remains `0`; the review reports `conflict: false`.
5. Ordinary admin approval succeeds and closes the flag. The warehouse now shows **No / 16 November 2026**, even though the response verified the earlier answer.

The opposite direction also required unnecessary work: an Availability correction was refused whenever a review date already existed, requiring a separate flag or dashboard edit to clear it.

**Implemented resolution:** `availabilityReview` replaces the two separate registry keys. The existing View keeps its two fields and offers one checkbox for the pair. The employee sees both controls, and changing Availability clears the previous date in the draft. Both correction and no-change responses snapshot both values. A strict correction payload requires both properties; no missing date is inherited from the current warehouse.

The database trigger increments one shared revision when either value changes and records both values in each history entry. Baseline, Proposed and Current each contain the complete pair. Admin approval writes the selected pair, flag closure and decision audit in one transaction; an edit to either after comparison returns `CURRENT_CHANGED`. Changing and reverting still invalidates the old comparison. Unrelated warehouse edits remain independent. The existing normal View/Edit paths remain available.

Regression coverage includes the original date-only-response failure, all three choices after either member changes, stale employee correction/no-change drafts, pending no-change conflicts, changes followed by reverts, paired history, legacy partial history, an Availability correction with an existing date, and rollback of both values/history/revision if closure fails. The test database now uses the schema's native calendar-date columns so snapshot checks match production types.

## Findings fixed during this review

| Priority | Finding and consequence | Implemented correction |
| --- | --- | --- |
| P1 | The migration created raw phone/proposal/history tables without row-level security. A local unprivileged role with SELECT access could read an unmasked phone snapshot without the API's assignment/reveal checks. | Enabled RLS on all five tables, revoked public and database API role access, and added migration verification of backend permissions. A real low-privilege-role test now returns no snapshots. No claim is made that deployed data was exposed; this migration has not been deployed. |
| P1 | Shared ingestion schemas coerced malformed JSON such as `false`, `true`, arrays and empty strings into numeric proposals. Those proposals could become valid stored coordinates or area values. | Numeric review proposals must be finite JSON numbers or explicit null. Required stored Zone/set values also cannot be staged as unsupported nulls. |
| P2 | A slow Refresh response could overwrite a successful employee submission and put the field back into an editable state on screen. | Invalidated older reads when a mutation begins or succeeds; scoped responses to the current review/identity; prevented duplicate in-flight writes. Added a regression that resolves requests in the wrong order. |
| P2 | Queue data and filters were not reset when identity/role changed. URL state, modal state and review ID were duplicated. | Reset the queue at the identity boundary and use the URL as the sole source of the open review. A late request from the previous identity is ignored. Removed the redundant refresh callback. |
| P2 | Once a new edit existed, older available audit history disappeared. Timestamp ties could also put edits in the wrong order, and old handover part edits were omitted. | Merge earlier field-specific summaries with new snapshots, retain an edit revision for deterministic ordering, and label legacy handover parts explicitly. The combined result remains capped at 100 edits. |
| P2 | Handover showed defaults without necessarily putting them in the payload. Editing a date or duration could then be rejected. Legacy fixed dates could display as missing. | Reuse the normal Handover formatter and shared form controls. The form sync keeps Fixed as the initial mode but leaves an unchosen unit empty, supports clearing dates and preserves inactive timing values. Equality checks ignore JSON key order and values belonging to the inactive mode. |
| P2 | The frontend compared raw JSON while the server compared meaning. A proposed `24.0` and current `24` unnecessarily requested an overwrite reason and confirmation. | The server returns whether each choice would replace the current value; the UI uses that result. There is one authority for comparison semantics. |
| P2 | Google Maps resolution ran while holding database locks and imposed a URL → Latitude → Longitude approval sequence absent from the current normal form. Coordinate tagging also acquired a second database connection inside the write transaction. | Removed the extra Maps lookup/coupling; URL corrections follow current form validation and change only the URL. Load polygon data before acquiring write locks, then calculate tags from the latest locked coordinate pair. A delayed-preparation test confirms other writes are not blocked. |
| P2 | Every flag displayed the cycle creator as its comment author, including flags added later by a different admin. | Store the actual author on each flag. Missing legacy authors are identified as unrecorded instead of guessed. |
| P2 | Large numeric search text could overflow the warehouse ID column and fail the queue request. | Only valid 32-bit warehouse IDs are included in the ID search branch; other numeric input remains a text search. |
| P3 | All details removed the alternate contact entirely, making an existing number appear missing. | Return a masked alternate contact while retaining the existing View component and its normal controls. |

Implementation locations: `scripts/sql/fieldReview.sql`, `scripts/migrateFieldReview.js`, `src/fieldReview/{fields,equivalent,service}.js`, and the frontend's `FieldReviewQueue`, `FieldReviewDialog`, `ReviewField` and `values` modules.

## Complexity assessment

The transactional approval, per-field versions and audit records are justified. They protect against simultaneous admins, changes followed by reverts, unrelated edits, partial failure and retries. Removing those protections would simplify code while breaking the agreed behavior.

The five tables have distinct responsibilities: review ownership/cycles, current flag state, response/decision history, a field revision counter, and warehouse edit snapshots. A generic workflow engine, external event bus, background jobs or a second normal warehouse View are unnecessary here; none were added.

The avoidable complexity was duplicated modal/URL state, separate frontend comparison rules and extra Maps approval dependencies. Those have been removed. Availability and Last reviewed now use the same existing compound-field and per-field concurrency approach as Handover, with no additional workflow state or table.

**P2 follow-up, not a demonstrated correctness failure:** queue counts currently materialize groups for every matching warehouse, and the latest-cycle query uses Prisma `distinct`. This deserves database-side counting/pagination and a realistic-volume query check before heavy use. No production-size load test was performed; the small-fixture timings are not performance evidence.

The field registry, database tracking list and View bindings are coordinated manually. All **76** keys currently match; the two availability keys became one. A contract test checks registry/tracker coverage. Adding a field must also update its View binding; introducing a generic metadata-driven replacement View would conflict with the agreed UX.

## Validation and its limits

- **37 backend validation/equality/route tests passed** again in this pass. The earlier broad adversarial audit also ran 86 backend unit/route/regression tests.
- **57 PostgreSQL integration tests passed**, including the linked availability scenarios above, migration failure rollback, hidden Handover timing preservation, permission-aware assignment, actual row locks, concurrent decisions, transaction rollback, RLS, changes followed by reverts, identity/assignment changes, retries, numeric search, deterministic history and location preparation.
- **31 frontend component tests passed** across the suite and targeted reruns. These include linked selection/summary, draft preservation in the actual All details modal, complete pair serialization, conflicts/history/confirmation, reopening after Current changes, stale reads, identity changes, reassignment recovery and the shared form controls.
- **Six browser workflows passed**, three each at 1280 px and 390 px, using the real review API and disposable PostgreSQL. They cover creation in normal View, employee response, admin conflict/no-change verification, history/reopening, shared form controls, the availability pair and a second edit made while replacement confirmation is open. The latter must reject the stale choice and require a new decision.
- Production frontend build, targeted lint and whitespace checks passed. The earlier full frontend lint run had no errors and reported one existing `Dashboard.jsx` hook-dependency warning outside this change. Existing bundle-size warnings and a jsdom modal measurement warning remain; no browser workflow failed on these.

The database fixture was tightened during the review: it now preserves required columns, native calendar-date columns, actual defaults and relevant foreign keys rather than silently inventing empty values. It still excludes PostGIS/vector infrastructure and unrelated deployed triggers. Browser sign-in and the surrounding dashboard loading shell are fixtures; review API calls are real. Test users have explicit warehouse permissions and the employee is the original uploader. All 76 field bindings match the registry; not every editor was exercised in a browser.

The Availability failure and the five second-pass defects have passing regressions and are no longer unresolved correctness blockers in the reviewed paths. The additive migration must still be applied and inspected in the intended deployment before enabling the UI; it has only been run locally so far. These checks do not constitute a production load test or a review of unrelated branch changes, and cannot prove the absence of every defect.
