# Warehouse form rollout

The new Scout and dashboard forms require Land Type and Google Location. Measurements still use the existing string columns, for example `50 feet`; this release needs no schema migration.

Keep `WAREHOUSE_FORM_REQUIREMENTS_ENFORCED` unset or `false` during rollout. Older clients may still create records without these fields, and older edits retain the previous clearing behavior. Other authentication, permissions and validation remain in place. The new UI independently requires these fields on creation and when changed during an edit.

After older clients have migrated, set `WAREHOUSE_FORM_REQUIREMENTS_ENFORCED=true` and restart the backend to enforce the requirements server-side. Unchanged missing values on existing records remain saveable. There is no automatic expiry or time-based switch.

Google pin verification is deferred. Scout/dashboard creation and edits do not wait for Google requests. Partner ingest keeps its existing coordinate enrichment.

Roll out this compatible backend before the updated frontends. Do not force users to refresh mid-entry: the dashboard does not persist unfinished edits across reloads.

Tests cover older submissions with missing/null fields, later strict enforcement, preserved legacy edits, international contact numbers, unit display and saving while Maps is unavailable.
