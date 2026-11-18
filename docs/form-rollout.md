# Warehouse form rollout

The Scout and dashboard forms and their API routes always enforce the required PPT v3 answers, including Land Type and Google Location. There is no environment flag or activation step. Existing blanks and unchanged legacy formats remain saveable; saved answers cannot be cleared. Measurements still use the existing string columns, for example `50 feet`; this release needs no schema migration.

Google pin verification is deferred. Scout/dashboard creation and edits do not wait for Google requests. Partner ingest keeps its existing coordinate enrichment.

Release the backend with both updated frontends. Older clients cannot submit incomplete new records and need to reload to edit protected answers with the required snapshot. Let users finish or copy unfinished entries before refreshing: the dashboard does not persist unfinished edits across reloads.

Tests cover rejected incomplete new submissions, preserved legacy edits, international contact numbers, unit display and saving while Maps is unavailable.

## PPT v3 requirements

The dashboard and Scout forms now also require the PPT v3 specification answers on new submissions:

- Clear height, flooring type, floor strength, dock count, plinth height, canopy and ventilation.
- Power (a measurement or the explicit **As per requirement** choice).
- At least one known washroom count; zero means there are none.
- An explicit Yes/No Fire NOC answer and fire safety measures (enter **None** when applicable).
- A handover date, or a whole-number lead time from 1–120 plus Days/Weeks/Months.

Warehouse type, address, Google Location, land type, offered area and rent remain required. Insulation and building stability certification are excluded from v3. V3 toilets now displays the stored washroom answer or **Unconfirmed** for old missing data; TCI is unchanged.

The form and API checks apply immediately. The old PPT and land/location rollout switches have been removed; leftover environment values do not disable validation. Requirements stay in the application, not the Prisma/PostgreSQL schema.

An existing saved blank may stay blank, including on pending submissions created before enforcement. Unchanged legacy formats remain saveable. Once a value is saved, neither an ordinary edit nor a staged or field-review correction can clear it. Corrections must supply valid replacements. Male and Female washroom counts are protected individually: `Male: 3; Female: 2` cannot become just `Female: 2`, but `Male: 0; Female: 2` is valid. A previously unknown count may remain unknown. Handover is validated as one selected timing answer; switching modes requires complete replacement timing, while saved inactive dates and lead times remain protected. Field-review mode switches retain the latest inactive timing. Omitted fields in partial edits are left alone. Old pending submissions may still be approved; partner ingest retains its existing contract.

These are application validations, with no Prisma/PostgreSQL schema change, backfill or ID/date cutoff. Existing warehouses without a `WarehouseData` row can save edits and fill their missing details: a nested upsert creates the relation when needed. Field-review verification rechecks the live, locked row, including proposals submitted before enforcement.

The updated forms freeze `expectedFormValues` from the original record when opened. This request-only metadata contains every protected PPT answer and all four handover values; it is validated and never persisted. Background contact refreshes do not replace this baseline. The API removes unchanged protected answers from the update, so saving an Address edit from an older form cannot revert a newer Power answer. An intentional conflicting edit returns HTTP 409 / `FORM_FIELDS_CHANGED`; the draft stays open and the user must refresh the list, reopen the record and check the latest answers. Retrying an already-applied answer is safe. Conditional update predicates also close the gap between the service read and database write, including simultaneous nested edits and creation of a missing details row. This concurrency contract covers the protected PPT fields and handover; it does not extend to every unrelated warehouse field.

Protected-field edits without `expectedFormValues` return HTTP 409 with instructions to reopen the form. An older loaded JavaScript bundle needs a page refresh before reopening. Existing records may still retain their old blanks; their age does not bypass validation when a saved answer changes.

Scout drafts retain the existing storage key and move to version 3. A pre-v3 draft's default `false` Fire NOC value is reset to unanswered, since the old switch could not distinguish an explicit No from no answer. Other draft data and uploads are retained. Final submission revalidates every step.

The backend's pure `src/utils/pptFormPolicy.js` is the canonical rule body. Regenerate the dashboard and Scout copies with `node scripts/syncPptFormPolicy.cjs --write` from the backend; only CommonJS versus ESM exports differ. Before releasing, run `npm run check:form-policy` with `Backend_Repository`, `Frontend_Repository` and `Scout_Frontend` checked out beside one another. The check fails for missing or different copies. Each repository also has the same field-by-field contract tests; both clients validate their serialized control values. API validation accepts only the writable request paths, so read-shaped or stale nested objects cannot satisfy missing form answers.

Checks cover every required field on create and edit, legacy blanks, valid replacements, zero/No/None, units, partial handovers, drafts, manual and automatic approval, stale field-review proposals, individual washroom clearing, missing details rows, simultaneous saves, two-tab stale edits, idempotent retries, and v3 display. Run the normal unit suites in all three repositories, backend `test:integration` for `pptForm.test.js` and `fieldReview.test.js`, dashboard `e2e/form.e2e.mjs`, and Scout `e2e/readiness.e2e.mjs`, plus `check:form-policy` and both frontend production builds. Integration/browser tests require the guarded disposable local `warehouse_qa` database; they never use the checkout's live `.env`.
