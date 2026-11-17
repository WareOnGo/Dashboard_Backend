# Optional WebP PPT exports

Plan dated 2026-09-24. Application implementation and deployment are pending.

Add an unchecked **Generate compressed PPT (beta)** checkbox to the existing
dashboard export modal. When selected, the backend will embed existing WebP
variants into the downloaded `.pptx`. Images remain available offline because
their bytes are embedded in the presentation.

The option applies to V2, V3, Detailed, Godamwale and TCI presentations, on desktop
and mobile. It is hidden for Last Mile Excel. The existing image registry has the
required `imageUrl`, `webpUrl` and `webpStatus` fields; this feature needs no schema
change or new backfill. Original R2 objects and `Warehouse.media` remain intact.

1. **Establish correct native WebP embedding.**

   Update `src/ppt/utils/image.js` to identify image formats from file bytes.
   Currently `normalizeImageBuffer` labels everything except PNG as JPEG,
   including WebP. A WebP must use `data:image/webp;base64,...` and become a
   `.webp` media part with the matching content type inside the PPTX. Preserve
   JPEG orientation correction and existing crop/contain behavior. Validate
   WebP headers and dimensions with bounds checks so truncated files can fall
   back safely. Do not transcode the WebP during export.

   The existing local probe at
   `tools/ppt-preview/out/webp-compatibility-2026-09-24/check.json` confirms that
   the installed PptxGenJS 3.12.0 packages a correctly typed WebP. A LibreOffice
   rendering artifact also exists. Microsoft PowerPoint compatibility remains
   to be verified using the actual generated file.

2. **Resolve WebP variants once per compressed export.**

   Add a read-only batch lookup to `src/models/imagePipelineRepository.cjs`,
   using the injected application's Prisma client. Select only the original
   URL, WebP URL and status needed for this feature. In
   `src/services/pptGenerationService.js`, collect the original URLs selected
   for the deck, including the existing template-specific fallback photo
   sources. Match registry rows by the exact original URL, never by image
   position or filename.

   Create a loader scoped to this export and pass it through the builders to
   image slides. For each original URL:

   | Condition | Image to embed |
   | --- | --- |
   | Checkbox off or flag omitted | Existing original image path |
   | Checkbox on, `webpStatus = READY`, valid WebP available | WebP bytes |
   | Missing registry entry, unfinished variant, missing WebP URL | Original bytes |
   | WebP download, validation or decoding fails | Retry with the same original |
   | Registry lookup fails | Use originals for this export |
   | Original also fails | Existing per-slide missing-image behavior |

   Preserve selection order and V3's separate `photos`/`cad` lists. Cache each
   image load within the export so repeated slide uses share the fetch and its
   fallback result. Use bounded download timeouts within the existing request
   budget; do not perform compression or labeling jobs during export. Normal
   exports do not need a registry query. Concurrent exports must not share a
   mutable compression flag.

3. **Thread the option through every PPT image path.**

   Add an optional trailing options object to `PptGenerationService.createBuffer`
   and the builders, retaining current defaults for existing callers. Cover V3's
   detail strip, photo pages and CAD pages; V2, Godamwale and TCI photo grids; and
   Detailed's hero and photo pages. `mainSlide.js` and `detailedSlide.js` currently
   download images directly, so route those warehouse photos through the same
   loader too. Honor the option on the legacy standard PPT endpoint as well.

   Keep existing slide layouts and template-specific image selection rules.
   Static branding, cover artwork and generated map images keep their current
   paths. CAD drawings use WebPs where available and retain contain sizing;
   drawing readability is part of validation.

4. **Add one request field and the checkbox.**

   Use a top-level `compressedPpt` boolean in existing PPT POST bodies alongside
   `ids`, `selectedImages` and `customDetails`. Omitted means `false`; reject
   non-boolean values on PPT endpoints instead of treating strings as truthy.
   Parse and pass it in `src/controllers/pptController.js`. Keep authentication,
   downloads and existing endpoint paths. Record the flag in the existing export
   audit metadata alongside the current byte count and duration; log WebP and
   original fallback counts for troubleshooting without a new table.

   In the frontend, add the checkbox under Presentation Details in
   `src/components/PptConfigModal.jsx`. Initialize it to `false` and reset it to
   `false` whenever the modal is reopened. Keep its state when moving between
   modal steps. Suggested short hint: “Uses compressed images where available.”
   Forward the boolean through `MobileHeader.jsx` and the five PPT functions in
   `src/services/pptService.js`. Keep original URLs in `selectedImages`; the
   backend chooses their variants. Do not send the option for Excel exports.

5. **Validate locally before production.**

   Extend the existing tests and PPT preview harness with targeted coverage:

   - Checkbox default/reset behavior, submission through every PPT format, and
     absence from Excel; omitted/false/true/invalid API flags.
   - Ready/missing/failed WebPs, failed registry lookup, download timeout,
     corrupt/truncated bytes, and original fallback. Include mixed-availability
     decks and concurrent normal/compressed requests.
   - Inspect the generated PPTX ZIP: actual WebP bytes, `.webp` media parts,
     `image/webp` content type and valid slide relationships. Confirm successful
     WebP replacement does not also embed that image's original as a fallback.
   - Exercise all five UI templates plus the legacy standard builder, including
     Detailed/TCI fallback photos, repeated V3 photos, CAD and rotated JPEG
     fallbacks. Preserve slide counts, selected image order and content flags.
   - Render paired decks locally. Compare the same five-option V3 deck with the
     checkbox off/on, recording total file sizes, generation time, WebP coverage
     and fallback count. Check whether it falls below 25 MB; this is a measured
     target, not a guarantee when large originals must be used.
   - Open, present, save and reopen the compressed deck in the PowerPoint
     versions used by the team/recipients, recording app and OS versions. Check
     images, crop, transparency, drawing legibility and file size after saving.
     Test PowerPoint desktop and web where they are used.

Microsoft has [announced WebP insertion support in Office](https://techcommunity.microsoft.com/discussions/microsoft365insider/add-webp-images-to-office-creations/2629808).
That announcement does not by itself prove that our generated native-WebP PPTX
works in every PowerPoint version. The fallback above happens during generation;
it cannot repair an unsupported viewer after download. Keep the option opt-in
and marked beta, and establish compatibility with the team's PowerPoint builds
before releasing it. Users can generate the existing default export when needed.

Implement and review the change locally first. Production rollout remains a
separate step after validation; deploy backend support before exposing the
frontend checkbox.
