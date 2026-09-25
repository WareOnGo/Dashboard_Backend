# Shared image registry: deployment

Updated 2026-09-25. Both backends now use the extended `labeled_warehouse_images`
table automatically. No read/write feature flags need to be added to hosting
settings. The shared Supabase image schema is already applied. Six JPEG variant
fields have been restored, and the JPEG pilot led to a manual two-pass backfill
at 1280px for photos (1920px for drawings). JPEG processing is not part of the
scheduled workers. See [JPEG pilot and backfill](jpeg-ppt-pilot.md).
`Warehouse.media`, original files and WebP results are preserved.

1. **Deploy the dashboard backend first.** Push the image-pipeline changes through
   its existing main-branch release workflow. Registration on warehouse saves,
   image reads and the stage-based label worker start with this version. Let any
   old label run finish before switching over. If old and new instances overlap
   during deployment, briefly pause the existing label trigger until all serving
   instances are updated, then resume it.
2. **Deploy the website backend.** Its existing WebP maintenance job and manual CLI
   now use the image table automatically. List/detail responses include `images`,
   and the `v8-images` cache namespace avoids reusing older cached responses.
   Keep the existing job schedules; no additional service is required.
3. **Deploy the frontend changes and rebuild the website.** The galleries consume
   explicit original/WebP pairs. Existing originals, media ordering, labels and
   the `photosWebp` compatibility projection remain available.
4. **Check production behavior.** Open a warehouse with completed WebPs and one
   with an original-only image. Save a new image and confirm a PENDING row appears,
   then check that the existing label and WebP jobs fill their own results. Check
   that captions survive compression, originals still load, private warehouses
   stay private, and `Warehouse.media` remains intact.

The dashboard workflow builds and publishes an ECR image; confirm App Runner has
actually taken the new release. Likewise, confirm Render has deployed the website
backend commit. A successful repository push alone does not establish that the
running services have updated.

Reconciliation fills missed registrations and unfinished work. The last read-only
inventory on 2026-09-24 found 31 referenced originals without rows and 272 pending
WebP rows; those counts can change with submissions. Pending work may reuse an
existing R2 object without recompression. Deployment does not itself run a backfill.

`IMAGE_PIPELINE_CACHE_URL` remains optional for immediate cross-backend cache
invalidation. Without it, cache expiry picks up label updates; no extra environment
configuration is required for the image pipeline to work. Static HTML still follows
the website's build schedule.

If a processor needs to be stopped, pause its existing trigger while correcting
the code. Keep a backend version that understands pending rows; the old label
worker treated any existing row as finished. Do not delete originals, remove media,
or reverse the additive schema as part of an application rollback.

The compressed-PPT checkbox and queue workers remain separate future changes.
