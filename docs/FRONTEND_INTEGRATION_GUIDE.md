# Frontend Integration Guide

How to wire a brand-new frontend into this backend: Google OAuth sign-in, authenticated API calls, and the presigned-URL file upload flow.

Backend base URL is referred to as `$API` throughout. In dev that's usually `http://localhost:3001`.

---

## 1. One-time backend ops config

Set these env vars on the backend (in addition to whatever is already set for the existing frontend):

```
ALLOWED_FRONTENDS=https://new-frontend.example.com,https://another.example.com
```

- Comma-separated list of frontend origins that are allowed to receive the post-login redirect.
- The default `FRONTEND_URL` is *always* implicitly allowed, so you don't need to list it here.
- Entries must match **exactly** what the frontend sends in `state` (scheme + host, no trailing slash).

Also add the new frontend's origin to the CORS allow-list in `src/app.js` (the `corsOptions.origin` array). Without this, the browser will block API calls.

---

## 2. Google Cloud Console config

**You do not need to create a new OAuth client.** All frontends share the one the backend already uses.

**Required redirect URIs** — only the backend's callback needs to be registered. Add whichever of these apply to your deployments:

```
https://<your-backend-domain>/auth/google/callback
http://localhost:3001/auth/google/callback    # for local dev
```

That's it. The new frontend does not need its own redirect URI registered. Google redirects to the backend; the backend then redirects to whichever frontend initiated the login (validated against `ALLOWED_FRONTENDS`).

**Authorized JavaScript origins** — not required for this flow (the frontend doesn't call Google directly). Leave the existing entries as they are.

---

## 3. Authentication flow

The backend is the OAuth client. Your frontend kicks off the flow and receives a JWT via a redirect.

### 3.1 Step-by-step

1. **User clicks "Sign in with Google"** on your frontend.
2. Frontend calls:
   ```
   GET $API/auth/google?state=<your-frontend-base-url>
   ```
   where `state` is the exact origin of your frontend (e.g. `https://new-frontend.example.com` — no trailing slash, must match a `ALLOWED_FRONTENDS` entry).

   Response:
   ```json
   { "success": true, "authUrl": "https://accounts.google.com/o/oauth2/v2/auth?..." }
   ```
3. Frontend redirects the browser to `authUrl`.
4. User authenticates with Google. Google redirects to the backend's callback.
5. Backend exchanges the code, generates a JWT, and redirects the browser to:
   ```
   <your-frontend-base-url>/auth/callback?token=<jwt>&user=<url-encoded-json>
   ```
6. Your frontend's `/auth/callback` route:
   - Reads `token` and `user` from the query string.
   - Stores the JWT (localStorage is fine; use an httpOnly cookie if you have a BFF).
   - Redirects the user into the app.

On failure, the backend redirects to `<your-frontend-base-url>/?error=<message>` — handle that on your landing page.

### 3.2 Domain restriction

The backend enforces `ALLOWED_DOMAIN` (defaults to `wareongo.com`). Any user whose Google email isn't on that domain gets rejected. If your new frontend needs different users, that restriction has to change on the backend (it's global, not per-frontend).

### 3.3 Example — kick off sign-in

```js
// window.location.origin works if your frontend is served from the root
async function signIn() {
  const res = await fetch(
    `${API}/auth/google?state=${encodeURIComponent(window.location.origin)}`
  );
  const { authUrl } = await res.json();
  window.location.href = authUrl;
}
```

### 3.4 Example — handle the callback

```js
// Route: /auth/callback
function handleAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const user = JSON.parse(decodeURIComponent(params.get('user') || '{}'));

  if (!token) {
    // Handle error path: ?error=<message> on your landing page
    return;
  }

  localStorage.setItem('jwt', token);
  localStorage.setItem('user', JSON.stringify(user));
  window.location.replace('/'); // or wherever your app lives
}
```

### 3.5 Using the token

Send it as a `Bearer` token on every API request:

```
Authorization: Bearer <jwt>
```

Token lifetime is controlled by `JWT_EXPIRES_IN` on the backend (default 24h). Refresh with:

```
POST $API/auth/refresh
Authorization: Bearer <current-jwt>
```

Returns `{ token, expiresIn, user }`. Watch for the `X-Token-Refresh-Suggested` response header — the backend sets it when a token is close to expiry.

### 3.6 Other auth endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/auth/me`      | Return the current user (requires `Authorization`) |
| `POST` | `/auth/logout`  | Client-side signal; JWTs are stateless |
| `GET`  | `/auth/health`  | OAuth/JWT configuration health check |

---

## 4. Creating a warehouse

### 4.1 Endpoint

```
POST $API/api/warehouses
Authorization: Bearer <jwt>
Content-Type: application/json
```

### 4.2 Request body

Required fields:

| Field | Type | Notes |
|---|---|---|
| `warehouseType`    | string         | non-empty |
| `address`          | string         | non-empty |
| `city`             | string         | non-empty |
| `state`            | string         | non-empty |
| `zone`             | string         | non-empty |
| `contactPerson`    | string         | non-empty |
| `contactNumber`    | string         | non-empty |
| `totalSpaceSqft`   | number[]       | at least one integer |
| `compliances`      | string         | non-empty |
| `ratePerSqft`      | string         | non-empty |
| `uploadedBy`       | string         | non-empty (typically user email) |
| `warehouseData`    | object         | nested — see below, all fields optional |

Optional top-level fields: `warehouseOwnerType`, `googleLocation`, `postalCode`, `offeredSpaceSqft`, `numberOfDocks`, `clearHeightFt`, `otherSpecifications`, `availability`, `visibility` (bool), `isBroker`, `photos`, `media`.

`media` shape (all arrays default to `[]`):
```json
{ "images": ["https://..."], "videos": ["https://..."], "docs": ["https://..."] }
```
The URLs in `media` are the public URLs returned by the presigned-URL flow (see §5).

`warehouseData` (all optional, all nullable):
`latitude`, `longitude`, `fireNocAvailable` (bool), `fireSafetyMeasures`, `landType`, `vaastuCompliance`, `approachRoadWidth`, `dimensions`, `parkingDockingSpace`, `pollutionZone`, `powerKva`.

### 4.3 Example

```js
async function createWarehouse(formData) {
  const res = await fetch(`${API}/api/warehouses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${localStorage.getItem('jwt')}`
    },
    body: JSON.stringify({
      warehouseType: formData.warehouseType,
      address: formData.address,
      city: formData.city,
      state: formData.state,
      zone: formData.zone,
      contactPerson: formData.contactPerson,
      contactNumber: formData.contactNumber,
      totalSpaceSqft: [formData.totalSpaceSqft],
      compliances: formData.compliances,
      ratePerSqft: formData.ratePerSqft,
      uploadedBy: formData.userEmail,
      media: {
        images: formData.uploadedImageUrls,
        videos: [],
        docs: formData.uploadedDocUrls
      },
      warehouseData: {
        latitude: formData.lat,
        longitude: formData.lng,
        // ...the rest are optional
      }
    })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Create failed');
  }
  return res.json();
}
```

### 4.4 Other warehouse endpoints

All require `Authorization: Bearer <jwt>`.

| Method | Path | Purpose |
|---|---|---|
| `GET`    | `/api/warehouses`                    | List all |
| `GET`    | `/api/warehouses/search`             | Search (query params) |
| `GET`    | `/api/warehouses/statistics`         | Aggregates |
| `GET`    | `/api/warehouses/:id`                | Fetch one |
| `GET`    | `/api/warehouses/:id/contact-number` | Contact number for a warehouse |
| `PUT`    | `/api/warehouses/:id`                | Update (same schema, all fields optional) |
| `DELETE` | `/api/warehouses/:id`                | Delete |

---

## 5. File uploads (presigned-URL flow)

Files never go through the backend. The backend hands you a short-lived S3/R2 URL; you `PUT` the file to that URL directly; then you include the resulting public URL in the warehouse create payload.

### 5.1 The three steps

1. **Ask the backend for a presigned URL.**
2. **PUT the file bytes to that URL** (direct to object storage).
3. **Optionally validate**, then use the returned public URL in your warehouse create payload.

### 5.2 Step 1 — request a presigned URL

**Single file:**

```
POST $API/api/warehouses/presigned-url
Authorization: Bearer <jwt>
Content-Type: application/json

{ "contentType": "image/jpeg" }
```

Optional body fields: `expiresIn` (seconds, default 360), `keyPrefix` (string).

`contentType` must start with `image/` or `video/`, or equal `application/pdf`. Anything else is rejected.

Response:

```json
{
  "success": true,
  "data": {
    "uploadUrl":  "https://...signed...",
    "imageUrl":   "https://public-cdn.example.com/<fileName>",
    "fileName":   "<generated-unique-name>.jpg",
    "contentType":"image/jpeg",
    "expiresAt":  "2026-04-19T12:34:56.000Z"
  }
}
```

- `uploadUrl`  — PUT your file bytes here. Expires at `expiresAt`.
- `imageUrl`   — the permanent public URL. Save this into your warehouse payload (`media.images`, etc.). Name is historical — same shape applies to videos/PDFs.
- `fileName`   — used for validate/delete/info calls.

**Batch (up to 10 files):**

```
POST $API/api/warehouses/presigned-urls/batch
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "uploadRequests": [
    { "contentType": "image/jpeg" },
    { "contentType": "application/pdf" }
  ]
}
```

Returns `{ uploads: [...same shape as single...], batchId, totalFiles }`.

### 5.3 Step 2 — upload the file directly

```js
await fetch(uploadUrl, {
  method: 'PUT',
  headers: { 'Content-Type': file.type }, // MUST match the contentType you requested
  body: file
});
```

Gotchas:
- Do **not** send the `Authorization` header on this PUT — it'll conflict with the presigned signature.
- `Content-Type` must be identical to what you declared in step 1, or S3/R2 will reject the upload.
- This call is browser → object storage directly; your backend isn't involved.

### 5.4 Step 3 (optional) — validate

```
POST $API/api/warehouses/files/:fileName/validate
Authorization: Bearer <jwt>
```

Confirms the file exists in storage and passes size/type checks. Use this if you want a belt-and-braces check before saving the warehouse.

Also available:
- `GET    /api/warehouses/files/:fileName`   — file info
- `DELETE /api/warehouses/files/:fileName`   — delete

### 5.5 End-to-end example

```js
async function uploadFile(file) {
  // 1. Ask for presigned URL
  const presignRes = await fetch(`${API}/api/warehouses/presigned-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${localStorage.getItem('jwt')}`
    },
    body: JSON.stringify({ contentType: file.type })
  });
  const { data } = await presignRes.json();

  // 2. PUT bytes to object storage
  const putRes = await fetch(data.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file
  });
  if (!putRes.ok) throw new Error('Upload failed');

  // 3. Return the permanent public URL for use in the warehouse payload
  return data.imageUrl;
}

// Wiring it into the form submit
const imageUrls = await Promise.all(files.map(uploadFile));
await createWarehouse({ ...form, uploadedImageUrls: imageUrls });
```

---

## 6. Error handling quick reference

All error responses look like:

```json
{ "error": "message", "code": "CODE_STRING", "timestamp": "..." }
```

| Status | Meaning | What to do |
|---|---|---|
| 400 | Validation failed (Zod)     | Show field errors; inspect `issues` array when present |
| 401 | Missing / expired JWT       | Redirect to sign-in, or call `/auth/refresh` |
| 403 | Wrong email domain or scope | Show "not authorized" message |
| 404 | Resource not found          | Normal "not found" UI |
| 503 | Backend/OAuth unhealthy     | Retry with backoff |

Specifically for auth, watch for `code: "TOKEN_EXPIRED"` — that's your cue to refresh or re-auth.

---

## 7. Checklist when adding a new frontend

- [ ] Add the new frontend's origin to `ALLOWED_FRONTENDS` on the backend.
- [ ] Add the new frontend's origin to the CORS allow-list in `src/app.js`.
- [ ] Implement `/auth/callback` route on the frontend to read `token` + `user`.
- [ ] Call `GET /auth/google?state=<origin>` to kick off sign-in.
- [ ] Attach `Authorization: Bearer <jwt>` to every `/api/*` call.
- [ ] Use the three-step presigned-URL flow for any file uploads.
- [ ] Users signing in must be on the `ALLOWED_DOMAIN` (defaults to `wareongo.com`) — change backend config if that's wrong for this frontend's audience.
- [ ] **No changes required in Google Cloud Console.**
