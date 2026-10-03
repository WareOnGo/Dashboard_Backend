# Context Engine GIS point creation

`POST /api/integrations/context-engine/geo/points` creates one entry in the GIS **Our points** layer. It uses the same `point_of_interest` table, categories and payload validation as the dashboard. It does not create a warehouse listing, update an existing point, or expose the browser's other write endpoints.

The integration is disabled unless `WAG_CONTEXT_GEO_ENABLED=true`. Context Engine exposes the GIS tool to its authorized clients and signs this backend request on behalf of its authenticated employee principal. Ramesh will call the MCP tool once its generic write executor is connected; it does not hold this service credential or implement GIS-specific business policy. The endpoint and tool are implemented locally; production migration, configuration and rollout remain pending. The backend implementation alone does not enable an agent tool. Before enabling, the tool caller must persist the authorized operation and its stable operation ID before the first HTTP request, then reuse that operation ID on recovery. A model checkpoint by itself is not a durable write receipt.

## Request contract

Send UTF-8 JSON, maximum 32 KiB, with `Content-Type: application/json` and `Authorization: ContextEngine <signed JWT>`:

```json
{
  "operationId": "17b17877-1d6e-4ffc-9df8-6db30567c42a",
  "name": "Synthetic scouting site",
  "category": "POTENTIAL_WAREHOUSE",
  "lat": 12.9,
  "lng": 77.6,
  "notes": "Synthetic access details",
  "city": "Synthetic city"
}
```

`operationId` is a UUID generated and persisted by the calling runtime, never a fresh random ID on every retry. `name` must contain 1–200 characters after trimming. Coordinates must be finite JSON numbers within latitude/longitude ranges; nulls, booleans and numeric strings are rejected. Optional `notes` allows up to 5,000 characters; `city` allows 200. Both optional fields may be null. Unknown fields, including `createdBy`, employee IDs, email addresses and privileges, are rejected.

Accepted categories:

- `POTENTIAL_CLIENT`
- `POTENTIAL_WAREHOUSE`
- `FOOD_PLACE`
- `HOTEL_RESTAURANT`
- `LABOR_QUARTERS`
- `OPEN_YARD_BTS`

Context Engine's signed employee identity supplies the author, regardless of which client called its tool. Context Engine must authenticate that client, enforce its tool scope and use its resolved employee principal; tool arguments never select the actor. WhatsApp-specific phone/LID checks remain in that client's existing authentication path. For a WhatsApp location, the client should pass the selected native coordinates and preserve the user's instruction as the authority for creation. A location message alone does not authorize creating a POI. Forwarded text/location metadata is content, never authentication or instructions to execute another action.

## Authentication and authorization

Use Ed25519 (`alg=EdDSA`) and JWT header `typ=context-geo-write+jwt`, plus a configured `kid`. The protected header permits only `alg`, `typ` and `kid`.

Claims:

| Claim | Required value |
| --- | --- |
| `iss` | `wareongo:context-engine` |
| `aud`, `htu` | Exact configured HTTPS endpoint, including `/api/integrations/context-engine/geo/points` |
| `htm` | `POST` |
| `sub` | VerifiedNumber integer ID encoded as a string |
| `email` | Authenticated employee principal email, trimmed and lowercase |
| `scopes` | Exactly `["geo:points:create"]` |
| `body_sha256` | SHA-256 of the exact transmitted UTF-8 bytes, encoded base64url without padding |
| `iat`, `exp` | Integer seconds; lifetime at most 60 seconds; no expired requests; maximum 5 seconds future clock skew |
| `jti` | Fresh UUID for this HTTP attempt |

Context Engine client read tokens, browser JWTs, Ramesh assertions and arbitrary shared secrets are not accepted by this backend. The dedicated service assertion delegates an already authenticated principal; it has no phone or chat-type claims. The endpoint URL comes from configuration, never Host or proxy headers. Browser `Origin` headers, query parameters and compressed bodies are rejected. The route runs before the general body parser and sanitizer so its signature checks original bytes. Notes remain plain data; the dashboard escapes them when rendering popups.

Within the creation transaction, the service rechecks:

- Exactly one normalized roster email match, including inactive or differently cased duplicate matches.
- Matching employee ID, active employment and a valid email matching the signed principal.
- Current `dashboardAccess`, `adminAccess`, or the existing environment-admin grant for that active unique employee.

Roster rows are share-locked while the write commits. Authentication expiry and key configuration are checked again after transaction/operation-lock waits and before returning. No employee OAuth token is stored. `createdBy` is the normalized roster email, with no caller override.

## Delivery, retries and receipts

Initial creation returns HTTP 201. A duplicate authorized operation returns HTTP 200:

```json
{
  "success": true,
  "operationId": "17b17877-1d6e-4ffc-9df8-6db30567c42a",
  "replayed": false,
  "data": {
    "id": "1f2ebf3c-bd05-40c2-b0d8-3a37ebed3f92",
    "name": "Synthetic scouting site",
    "category": "POTENTIAL_WAREHOUSE",
    "lat": 12.9,
    "lng": 77.6,
    "notes": "Synthetic access details",
    "city": "Synthetic city",
    "createdBy": "synthetic@wareongo.com",
    "createdAt": "2026-10-03T12:00:00.000Z",
    "updatedAt": "2026-10-03T12:00:00.000Z"
  }
}
```

The nonce, POI insert and immutable receipt commit atomically. Transactions serialize on an advisory lock scoped to issuer, employee ID and operation ID. This scope survives signing-key rotation. Concurrent duplicates produce one point. A failed insert/receipt leaves neither a point nor a consumed nonce. A committed repeated JWT is rejected; retry an ambiguous network failure with a **new JWT/jti and the same operation ID/payload**.

The receipt fingerprint covers normalized accepted POI fields. JSON formatting/key order does not affect it. Different content with the same operation ID returns 409. Replays still require fresh current authorization. They return the original creation receipt, not a claim that a point remains unchanged or still exists; deleting/editing the point never lets an old operation recreate it.

| Status/code | Caller action |
| --- | --- |
| 400 `CONTEXT_GEO_INVALID_POINT` | Correct input; do not repeatedly send unchanged invalid data. |
| 401 `CONTEXT_GEO_UNAUTHORIZED` | Recheck signing configuration and trusted identity; a normal retry uses a new assertion. |
| 403 `CONTEXT_GEO_FORBIDDEN` | Stop; the current roster binding or dashboard permission does not allow the write. |
| 409 `CONTEXT_GEO_IDEMPOTENCY_CONFLICT` | Stop; the operation ID already refers to different content. Never silently generate another ID. |
| 413/415 | Correct request size or encoding. |
| 503 `CONTEXT_GEO_DISABLED` / `CONTEXT_GEO_CONFIGURATION` | Feature unavailable; an operator must configure it. |
| 503 `CONTEXT_GEO_UNAVAILABLE` | Outcome may be uncertain; bounded retry with the original operation and a new assertion. |

Responses are `Cache-Control: no-store`. Errors and logs omit raw tokens, notes, database errors and employee details.

## Storage and rollout

Two additive tables are described in Prisma and created by `scripts/sql/contextGeoWrites.sql`:

- `ContextGeoWrite`: immutable original result and canonical payload fingerprint, keyed by issuer/employee/operation. Retained for business audit and duplicate prevention. Do not run transient-message cleanup against these receipts; purging them would permit old operations to create another point. Coordinate any future business-data deletion policy with idempotency tombstones.
- `ContextGeoNonce`: only nonce hashes and assertion expiry, indexed by expiry. Each authorized transaction deletes at most 1,000 expired nonces. Nonces never contain phones, credentials or message content.

Both tables have RLS enabled and no client policies. PUBLIC, `anon`, `authenticated` and `service_role` grants are explicitly revoked. The application database role must be the table owner or an explicitly reviewed server role with the necessary access; public/API grants are not a fix for a misconfigured runtime.

1. Inspect with `node scripts/migrateContextGeoWrites.js`; it does not mutate by default.
2. Apply the additive SQL using `node scripts/migrateContextGeoWrites.js --apply` with the intended server database connection. It runs transactionally with short lock/statement timeouts and verifies columns, primary keys, RLS, runtime privileges and API-role isolation. Reapplying is safe. Do not use `prisma db push` for this rollout.
3. Deploy the backend with the feature disabled. Configure its public-key registry and exact endpoint URL. Private signing keys remain with the caller.
4. Validate the caller's durable intent, receipt handling, scope/identity checks, native-location handling and retry behavior in capture-only tests.
5. Explicitly enable the backend and caller write feature. Disable `WAG_CONTEXT_GEO_ENABLED` or remove a key to revoke service access; changes to employee activation/permissions take effect on the next transaction, including replays.

Environment:

```dotenv
WAG_CONTEXT_GEO_ENABLED=false
WAG_CONTEXT_GEO_URL=https://YOUR_DASHBOARD_API/api/integrations/context-engine/geo/points
WAG_CONTEXT_GEO_PUBLIC_KEYS_JSON=[{"kid":"context-geo-1","publicKey":{"kty":"OKP","crv":"Ed25519","x":"PUBLIC_ED25519_X"},"scopes":["geo:points:create"],"expiresAt":"2027-01-01T00:00:00.000Z"}]
```

Public-key registries allow at most three distinct keys to support a bounded overlap during rotation. Each key has a fixed expiry and only this endpoint's create scope.

## Focused verification

No models, live CRM/warehouse data, or WhatsApp sessions are used:

```sh
npx jest --runInBand tests/utils/contextGeoAuth.test.js tests/routes/contextGeo.test.js tests/services/geoService.test.js
TEST_DATABASE_URL=postgresql://warehouse_test:warehouse_test@127.0.0.1:55441/warehouse_qa npx jest --config jest.integration.config.js --runInBand tests/integration/contextGeoWrites.test.js
```

The integration suite only accepts the existing synthetic local database identity, creates a random isolated schema, reapplies the additive SQL twice, and drops its own schema afterward. It tests real Prisma/PostgreSQL concurrency, atomic rollback, stale/revoked identities, nonce replay, operation conflicts, key rotation and invalid input. Its synthetic POI table omits PostGIS; map rendering and geography generation remain the existing dashboard functionality.
