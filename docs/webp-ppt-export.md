# Optional WebP PPT export

The dashboard's **Generate compressed PPT (beta)** checkbox starts unchecked on
each modal open. It applies to Standard/V2, V3, Detailed, Godamwale and TCI.
The legacy standard PPT endpoint supports it too. Last Mile Excel is unchanged.

PPT requests accept a top-level boolean:

```json
{
  "ids": "123,456",
  "compressedPpt": true,
  "selectedImages": { "123": ["https://example.com/original.jpg"] },
  "customDetails": { "clientName": "Example" }
}
```

Omitting the option or sending `false` uses originals and makes no variant
lookup. Non-boolean values on PPT routes return HTTP 400. V3 retains its existing
`{ "photos": [], "cad": [] }` selection format. Selections always contain
original URLs, including when the picker displays a WebP preview.

## Image handling

- One query to `labeled_warehouse_images` resolves the selected originals to
  their explicit `webpUrl` values. Detailed's implicit technical-slide hero and
  TCI's default photo grid are included. Matching uses the full original URL.
- The last published WebP remains usable while a newer processing attempt is
  pending, matching the image API's behaviour.
- Missing metadata, an invalid URL, a failed download or an unreadable WebP
  falls back to the same original. A failed registry lookup uses originals for
  the whole export. If both files fail, existing slide placeholders/skips apply.
- Lookup waits are capped at 3 seconds, WebP downloads at 5 seconds and original
  fallback downloads at 10 seconds. A request-local promise cache reuses both
  successes and failures across repeated V3 strips/photos or Detailed heroes.
- MIME types come from image bytes. Native `.webp` parts carry `image/webp` in
  the PPTX content types. WebPs are decoded for validation but embedded byte for
  byte, without encoding. Original JPEG EXIF rotation remains supported.
- The loader is attached to one presentation instance. Concurrent normal and
  compressed requests cannot change each other's image selection. Branding
  images and generated maps retain their existing loaders.

In compressed mode, the picker marks missing or failed WebP previews orange with
**Will be uncompressed**. The orange markers are part of the picker only.
Export audit metadata records `compressedPpt` and `imageStats`: unique originals
successfully served as WebP, original fallbacks, failed images, and lookup failure.

No schema migration, environment flag, storage write or backfill is required.
Deploy the dashboard backend before releasing the frontend toggle.

## Validation

`npm run test:ci` covers real PPTX ZIP output for all six builders, native WebP
content types, original fallback, corrupt/truncated/slow variants, unavailable
metadata, concurrent exports, repeated-image caching, implicit images, V3 CAD
slides, EXIF rotation, and the authenticated request contract.

Frontend tests cover default/reset behaviour, mobile/desktop export wiring,
orange badges, original URL identity, V3 selections, and Excel isolation.

Local verification on 2026-09-24 used cached real images with five synthetic
warehouse options, six photos each and the same overview map:

| Mode | PPTX size | Median local assembly (3 runs) |
| --- | ---: | ---: |
| Original | 25.28 MB | 1.65 s |
| Compressed | 5.60 MB | 0.64 s |

The compressed deck used 29 WebPs and one original fallback. Timings include
validation and packaging, but exclude real database/network latency. Paired
photo and layout slides were rendered and inspected in LibreOffice. Microsoft
PowerPoint desktop/web compatibility still needs a user check, hence the opt-in
beta label.
