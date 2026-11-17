# Field-review adversarial review — 17 November 2026

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
