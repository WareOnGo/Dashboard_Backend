# Warehouse analytics access

`analytics.warehouse` joins `public."Warehouse"` to `public."WarehouseData"`
on `WarehouseData.warehouseId = Warehouse.id`. It uses a left join and the
existing unique constraint on `WarehouseData.warehouseId`, giving one row per
warehouse even if a future warehouse has no data record.

The intended BI login is `analytics_reader`. It has SELECT on this view, no
memberships in other roles, no administrative attributes, and no direct grants
on the source tables. `warehouse_analytics_owner` is a separate NOLOGIN role
with explicit source-column grants and SELECT RLS policies. The view runs with
its owner's table permissions and has `security_barrier = true`.

## Column names restored: 2026-10-14

The live view now uses the original database column names for exposed source
fields. Examples are `id`, `warehouseOwnerType`, `warehouseType`, `totalSpaceSqft`,
`micromarket`, `createdAt`, and `fireNocAvailable`. The separate WarehouseData
primary key remains `warehouse_data_id` because both source tables call their
primary key `id`. Derived completeness flags and space count/min/max fields keep
their existing names. Arrays remain comma-separated text for BI compatibility.

The 48 column renames preserved all 95 column positions and types. An atomic
comparison of every row verified that all 2,809 warehouse records, their values,
the view owner, and grants were unchanged. Raw-table and write denials also passed.
The original Warehouse and WarehouseData tables were not modified.

Quote camelCase names in SQL, for example:

```sql
SELECT id, "warehouseType", "totalSpaceSqft", city, "fireNocAvailable"
FROM analytics.warehouse
LIMIT 100;
```

Queries that explicitly used an old alias must use the restored name. Existing
Data Studio sources need their fields refreshed. The local Metabase source is
refreshed as part of this change. The checked view-only migration is available as
`node scripts/provisionWarehouseAnalytics.js --update-view`; it does not alter
roles, connection limits, or source records.

## Initial deployment: 2026-10-06

The view and roles have been created in the configured Supabase project.
**The reader is now enabled and its password-authenticated SSL connection was
tested successfully through the session pooler on port 5432.** It is intended
only for the administrator's private, reusable Data Studio data source. The
analyst receives report access; the database credentials stay with the owner.

Connection details and the generated password are in
`.env.warehouse-analytics.credentials.json` at the backend repository root.
This file is ignored by Git and has permissions 0600. Store the password in
your password manager. No database password was printed in tool output.

Supabase's managed `net` schema grants USAGE to PUBLIC, and its
`http_request_queue` and `_http_response` tables grant read/write access to
PUBLIC. Every new SQL role inherits these grants. Revoking an individual
role's access cannot override them. The project `postgres` role has no grant
option on these objects; a transactionally tested REVOKE left PUBLIC's access
unchanged. No managed ACL changes were committed.

At inspection time, the request queue was empty. Among 62 response bodies,
one contained an email address. Three scheduled HTTP jobs use Bearer
authentication, including one that gets its credential from Vault. Their
request headers can appear in the queue, so its contents cannot be considered
endpoint-only metadata. No credential values or response bodies were logged.

The PUBLIC grant on the `public` schema also exposes PostGIS metadata and
privileged extension functions. The audit continues to report these paths.
The explicitly selected `--data-studio-only` mode accepts only the reviewed
extension relations and function signatures; unexpected data access,
memberships, writable schemas, and administrative attributes still block it.
**The SQL role is not isolated to the warehouse view.** Data Studio's private
source permissions are part of this access design. Do not give this password
or source-edit permissions to the analyst.

Before these credentials can be used for direct analyst SQL access, the
managed grants need to be addressed. The prepared script
[`warehouseAnalyticsManagedGrants.sql`](../scripts/sql/warehouseAnalyticsManagedGrants.sql)
requires the managed superuser, so it would need Supabase support. It has not
been executed. That script preserves existing roles' schema access,
removes the two PUBLIC schema-USAGE grants, and keeps the view owner's required
source access. It excludes the new analytics reader. Existing application
roles retain their access; future roles need explicit USAGE grants.

## Exposed data

The view explicitly lists 95 columns. It exposes property type, city/state/zone,
micromarkets, space options, commercial terms, dates, and property/facility
fields. Enum and array outputs are converted to BI-compatible text. Space
options also have count/min/max columns; the view does not sum potentially
alternative space options. Existing business text fields retain their original
types and formatting.

Phone numbers, alternate phone numbers, Google Maps links, latitude, longitude,
PostGIS geography, embeddings, full addresses, postcodes, contact names, owner
company/alternate contact, uploader identity, notes/descriptions, and media are
not exposed as values. They have `has_*` indicators where applicable. General
specification narratives, nearest-transport text, and land-parcel text also
remain hidden; the live scan found sensitive-looking content in some of those
fields. New source columns are not automatically exposed.

Text presence flags treat NULL and whitespace-only strings as missing. They
do not validate phone numbers or treat strings such as `N/A` as null. Coordinate
flags describe presence, not validity. `has_warehouse_data` distinguishes a
missing joined record from a present record with empty fields.

The explicit allowlist is not a general PII detector. Keep business data in
its intended columns; placing contact information in an approved business
field would require removing or sanitizing that field in this view.

## Verification and activation

Run from `Backend_Repository`; the script loads the existing `.env` without
printing its connection string:

```sh
node scripts/provisionWarehouseAnalytics.js
node scripts/provisionWarehouseAnalytics.js --apply
node scripts/provisionWarehouseAnalytics.js --verify
```

The default mode inspects. `--apply` creates the objects transactionally and
does not enable a new login. Existing unrecognized objects are rejected.

For a new disabled reader, strict activation after the managed grants have
been fixed uses:

```sh
node scripts/provisionWarehouseAnalytics.js --activate --credentials-file .env.warehouse-analytics.credentials.json
```

The owner-controlled Data Studio mode used for this deployment is:

```sh
node scripts/provisionWarehouseAnalytics.js --activate --data-studio-only --credentials-file .env.warehouse-analytics.credentials.json
```

Do not rerun activation on the current login; it is already enabled. Without
the explicit Data Studio flag, inherited extension access still blocks
activation. Both modes repeat the source-data and permission checks, generate
a fresh password, write a new local file with mode 0600, enable the login,
and verify an actual connection using that login. A failed connection check
disables the login again. Activation does not rotate an already active
account's password or overwrite an existing credentials file.

## Google Data Studio setup

1. Open [Data Studio](https://datastudio.google.com/). From its home page choose
   **Create > Data source > PostgreSQL**. Creating the source from the home page
   makes it reusable, with permissions separate from the report.
2. Select **Basic** and enter the connection fields below. Copy the password
   from the private credentials file; this is a dedicated database password,
   not a Supabase API key or the project administrator's password.

| Field | Value |
| --- | --- |
| Hostname | `aws-0-ap-south-1.pooler.supabase.com` |
| Port | `5432` |
| Database | `postgres` |
| Username | `analytics_reader.tirdnyekehllnuyxqzzh` |
| Password | `password` value in `.env.warehouse-analytics.credentials.json` |
| Enable SSL | Yes |
| Enable client authentication | No |

3. If the connector requests a server certificate, download the SSL root
   certificate from the Supabase project's **Database Settings** and upload
   it there. Supabase documents this certificate for session-pooler clients in
   its [SSL connection guide](https://supabase.com/docs/guides/database/psql).
4. Click **Authenticate**, select **Custom query**, and enter:

```sql
SELECT * FROM analytics.warehouse
```

5. Click **Connect**, name the source `Wareongo Warehouse Analytics`, and use
   **Owner's credentials**. The source exposes 95 scalar fields, including
   `has_phone`, `has_google_location`, and `has_coordinates`; the corresponding
   raw contact and location values are absent.
6. Create a report using this source. Check **Resource > Manage added data
   sources** to confirm it is **Reusable**. Keep the source itself private.
7. Share only the report with the analyst as **Editor**. They can build charts
   and controls from the provided fields without receiving source-edit rights
   or the database password. An embedded source would allow report editors to
   change its connection, so do not convert it to embedded.
8. Add a scorecard using **Count Distinct** of `id` to verify the
   connection. At activation it contained 2,727 warehouses; new warehouses
   appear as the source refreshes.

These steps follow Google's [PostgreSQL connector documentation](https://docs.cloud.google.com/data-studio/connect-to-postgresql)
and [reusable-source sharing rules](https://docs.cloud.google.com/data-studio/about-data-sources).
The Data Studio UI and sharing configuration have not been set up or tested
on the user's Google account; those steps are for the owner to complete.

Session mode is deliberate: Supabase recommends it for BI tools and it
supports prepared statements and session state. Data Studio uses JDBC.
Transaction mode (port 6543) is intended for short-lived connections and
requires server-side prepared statements to be disabled (for JDBC,
`prepareThreshold=0`), plus avoiding session-dependent behavior. We have not
tested that combination in Data Studio. See
[Supabase's connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres).

A read-only transaction default is configured for convenience; it does not
override inherited PUBLIC privileges. Keep the data source and password private.

## Recorded validation

- 2,727 view rows and 2,727 unique warehouse IDs; no missing joined records.
- Completeness counts match the source: 1 missing phone, 659 missing Google
  Maps entries, and 822 without a complete coordinate pair.
- Under `SET LOCAL ROLE analytics_reader`, reads of the original two tables,
  employee table, and `auth.users` are denied. Updating the view is denied.
- The view grants no usable access to `anon`, `authenticated`, or `service_role`.
- `analytics_reader` can log in; the view owner remains NOLOGIN. Both roles
  have no administrative privileges.
- An actual SSL login as `analytics_reader` read the joined view and a nested
  query matching Data Studio's custom-query pattern. It was denied reads of
  both source tables, the employee table, and `auth.users`; the read-only
  transaction default was confirmed.
- The managed-grant findings remain explicit in the audit and credentials
  file. The password is for the owner's private data source, not the analyst.
- Syntax and activation-policy tests passed, including rejection of additional
  business-table access, writes, role memberships, and privileged functions.

## Missing WarehouseData records repaired

At the user's request, empty WarehouseData records were inserted only for
warehouse IDs 382 through 388, using `ON CONFLICT ("warehouseId") DO NOTHING`.
No coordinates or property details were invented, and existing records were
untouched. The created WarehouseData IDs are:

| Warehouse ID | WarehouseData ID |
| --- | --- |
| 382 | 3249 |
| 383 | 3250 |
| 384 | 3251 |
| 385 | 3252 |
| 386 | 3253 |
| 387 | 3254 |
| 388 | 3255 |

The live post-check found all 2,726 warehouses matched.
