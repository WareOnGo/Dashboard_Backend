# Optional compressed PPT export (JPEG)

Updated 25 September 2026. This implementation replaces WebP PPT media with
published JPEG variants for compatibility with more presentation viewers.
The filename is retained for existing links.

The **Generate compressed PPT (beta)** checkbox starts unchecked on each modal
open. It applies to Standard/V2, V3, Detailed, Godamwale and TCI, including the
legacy standard endpoint. Last Mile Excel is unchanged.

Requests retain the same boolean `compressedPpt`. Omitted/false uses originals
without a variant lookup; non-boolean values on PPT routes return HTTP 400.
Selections always contain original URLs. V3 retains its `{ photos: [], cad: [] }`
selection format. General galleries and unchecked previews still prefer WebP.

## Image handling

- One query resolves exact original URLs to `labeled_warehouse_images.jpegUrl`,
  including Detailed's implicit hero and TCI's default grid. A previously
  published variant remains usable during a later processing retry.
- JPEGs are 1280px maximum edge, quality 82 for photos; documents retain 1920px.
  Small suitable originals can be registered as their own JPEG.
- Missing metadata, invalid URLs, failed downloads and unreadable JPEGs fall
  back to the same original. A failed lookup uses originals for the whole deck.
  If both files fail, existing placeholders/skips apply.
- Lookup is capped at 3 seconds, JPEG downloads at 5 seconds and originals at
  10 seconds. Reused originals get the original timeout and are fetched only
  once, including on failure. A request-local cache shares successes/failures
  across repeated strips/photos/heroes.
- MIME types come from bytes. JPEG variants are fully decoded for validation
  and embedded unchanged, without export-time compression. WebP/PNG/HTML bytes
  at a JPEG URL trigger the original fallback.
- Original JPEG EXIF rotation remains supported. If an original fallback is
  itself WebP, it is converted to lossless PNG for PPT compatibility. This rare
  fallback adds encoding time and can increase size. Ordinary JPEG variants
  need no encoding. Export never uploads or updates stored images.
- The loader belongs to one presentation. Concurrent normal/compressed requests
  cannot change each other's selections. Branding and maps keep their loaders.

In compressed mode the picker previews JPEGs and marks missing/failed variants
orange with **Will be uncompressed**. Warnings appear in the picker, not on slides.
A small original published as its own JPEG counts as available. Both image APIs
expose `jpegUrl` alongside `webpUrl`; `displayUrl` remains WebP-first. The website
list cache uses `v8-images` to avoid older responses without JPEG metadata.

Export audit metadata records `compressedPpt` and `imageStats`: `jpegImages`,
`originalFallbacks`, `failedImages`, and `registryLookupFailed`. Counts are per
unique original; `jpegImages` includes reused original JPEGs.

## Deployment

The six JPEG columns and backfill already exist in the shared database. Normal
image-pipeline migration includes their additive schema. Both Prisma schemas
must ship with the changes; normal installation generates the clients. Deploy
the dashboard backend before the frontend so the unchanged request flag resolves
JPEGs. The website backend keeps the shared image response contract consistent.
No environment flags are needed.

JPEG processing remains a manual backfill. New uploads without JPEG metadata
use originals until the backfill runs again. Labeling/WebP workers continue as
before. Originals, WebPs and `Warehouse.media` are preserved.

## Verification

On 25 September, all 1,156 dashboard backend tests, 335 frontend tests, 15 local
image-pipeline integration tests and the frontend production build passed.
Desktop/mobile browser checks verified JPEG previews, the unchecked default,
orange warnings, original selections and the photo/CAD request split.

Backend tests exercise all six real PPT builders and ZIP packaging, native JPEG
content types, exact bytes, missing/corrupt/truncated/slow variants, unavailable
metadata, reused originals, concurrency, caching, implicit images, layout slides,
EXIF rotation, WebP-original conversion and authenticated routes.

A real V3 export through `PptGenerationService` used warehouses 2737, 2731, 2726
and 2722, six photos each and an identical overview map:

| Mode | PPTX size | Slides | Selected images present |
| --- | ---: | ---: | ---: |
| Original | 28.81 MB | 12 | 24/24 |
| Compressed JPEG | 6.22 MB | 12 | 24/24 |

The JPEG deck is 78.4% smaller, with 24 successful JPEG selections, no fallback
and no WebP parts. The app read the production registry and downloaded published
JPEGs; originals came from the verified pilot cache. JPEG generation took 4.76
seconds including lookup/downloads/validation/packaging. The original run used
cached image files, so its timing is not directly comparable.

Both decks rendered successfully in LibreOffice with 12 pages. The photo grid
and technical-slide image were visually checked; the compressed grid retained
its layout and looked comparable at slide size. Artifacts are in
`/tmp/wareongo-jpeg-application-verification/`. Microsoft PowerPoint desktop/web
has not been exercised locally; the checkbox remains opt-in beta.
