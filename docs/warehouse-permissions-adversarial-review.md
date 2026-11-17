# Warehouse permission adversarial review

Scope: the four warehouse grants under Dashboard access, their dependency graph,
roster writes and backfill, direct and bulk warehouse reads/writes, exports, GIS,
file metadata, field reviews, and browser state when permissions change.

## Findings corrected

1. **High — cross-instance read revocation lag.** A warm process-local capability
   cache could continue allowing warehouse reads for 30 seconds after another server
   committed a revocation. All warehouse capability gates now resolve against the
   roster on every request, including GET/HEAD. The tradeoff is a roster lookup per
   warehouse request. Database failures deny access even if an old grant is cached.
   Route regressions first reproduced the bypass, then passed with the fix.
2. **Medium — retained export/itinerary state.** These tools retained warehouse and
   contact data when the authenticated view scope changed; late requests could reopen
   a preview. Their state now belongs to one scope lifecycle. Scope changes dispose
   of the state, discard late responses, and abort downloads, including when the file
   response has arrived but its body is still being read. Desktop and mobile tools
   require warehouse view access. The micro-market editor also disposes of cached
   warehouse pins and pending city suggestions when its warehouse scope changes.
3. **Medium — assignments the employee could not complete.** General roster
   eligibility did not imply permission to edit the assigned warehouse. Setup,
   creation, and reassignment now filter by the target warehouse's edit permission.
   Existing revoked assignees remain identifiable and their reviews remain read-only.
4. **Medium — statistics failure hidden by mocks.** The existing Prisma aggregate
   generated `AVG(integer[])`, which PostgreSQL rejects. A disposable database test
   reproduced this. The query now sums each warehouse's area array before averaging
   permitted warehouses, retaining the same escaped ownership filter as GIS.

## Boundaries verified and retained

- Own access uses exact case-insensitive uploader email, with SQL wildcard escaping.
  Submitted filters and uploader edits cannot widen it. Legacy names and missing
  attribution require all-access. Email reuse changes who matches historical email
  attribution; this design does not provide immutable employee-ID ownership.
- Active, uniquely rostered admins inherit all grants. Inactive, missing, and
  ambiguous identities fail closed. Dependency cascades run inside the roster
  update transaction; explicit false takes precedence over conflicting grants.
- Existing employee backfill is additive and rerunnable without restoring revoked
  grants. Following the requested default change, future employees receive View all
  and Edit own, with Dashboard and View own prerequisites; Edit all stays off.
  The review uses synthetic fixtures and
  does not change the 25 employees already backfilled in the live database.
- Staging Reviewer and Scout are separate permissions/workflows. Reviewer can still
  inspect and promote staged submissions and revoke approved submissions. Revoking
  Dashboard alone is not an organization-wide deny if another grant allows access.
- Public media URLs, downloaded files, and data already delivered cannot be revoked
  by row permissions. Open tabs learn new grants when authentication state refreshes;
  the server independently checks every subsequent warehouse request. A request
  authorized before a change may complete.

This is a bounded source and regression-test review, not a production penetration
test or a guarantee that every unrelated subsystem is free of vulnerabilities.

## Separate unresolved exporter concern

The existing PPT exporter passes caller-supplied `selectedImages` URLs to the image
loader, whose fallback calls `axios.get` without an explicit host/IP restriction.
See `src/services/pptGenerationService.js`, `src/services/pptImageService.js`, and
`src/ppt/utils/image.js:126`. The new warehouse-ID checks do not establish authority
to fetch an arbitrary URL. This is a separate server-side request forgery concern;
no live network exploitation was attempted during this review. Restricting selected
images to authorized warehouse media and enforcing a safe destination/redirect
policy needs a separate exporter change, including its stored image URLs.

## Validation

The final backend run passed all 84 suites / 1,784 tests. Disposable PostgreSQL
coverage passed all 58 tests, including literal email ownership,
backfill/defaults, statistics, and assignee eligibility. The selected frontend
regressions and the production build passed after rerunning the initially failing
field-review cases with the concurrent fixes present. Creation receipt fixtures
were updated to model the staging revision lookup added by concurrent work; all
six receipt tests then passed. No production data was changed during this review.
