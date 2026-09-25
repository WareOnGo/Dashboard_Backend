Website image approval — investigation and proposed implementation, 25 September 2026.

Recommendation: extend `labeled_warehouse_images` with website-specific approval and quality results. Select up to eight approved, useful photos per warehouse, with four as a soft minimum. Use weaker approved photos only to reach four. Contact restrictions always take precedence over image counts. Aim for an indoor/outdoor balance when the available useful photos support it.

A subsequent [Luna versus Terra benchmark](./website-image-model-benchmark-2026-09-25.md) uses fresh, identical-input runs and reviews disagreements. The user then approved the [Luna backfill and separate cron stage](./website-image-production.md). The investigation below records the earlier pilot; public website filtering remains a later rollout.

This investigation was a local evaluation and plan. At that stage no database schema, production image records, R2 objects, application routes, or deployed website behavior were changed. The inventory used a read-only database transaction; the image evaluation downloaded originals and called the existing VLM account. Results and review images are private local files under `/tmp/wareongo-website-image-eval`.

The read-only inventory at 08:21 UTC contains 2,130 public warehouses and 14,879 current image references: 7,480 indoor, 7,146 outdoor, 250 documents, and three unknown. Counts below use existing scene labels, before any proposed approval filtering.

| Availability among public warehouses | Count | Share |
| --- | ---: | ---: |
| Fewer than four scene photos | 581 | 27.3% |
| At least four scene photos | 1,549 | 72.7% |
| At least six scene photos | 1,006 | 47.2% |
| At least eight scene photos | 675 | 31.7% |
| Can supply two indoor + two outdoor | 953 | 44.7% |
| Can supply four indoor + four outdoor | 318 | 14.9% |
| Indoor photos only | 209 | 9.8% |
| Outdoor photos only | 416 | 19.5% |
| No indoor or outdoor photos | 38 | 1.8% |

The median warehouse has five scene photos; the 75th percentile has nine and the maximum is 65. A mandatory minimum of four would already be impossible for over a quarter of public listings. A mandatory 4/4 split would be impossible for 85.1%, even before filtering. Four is therefore a collection target and quality-fallback threshold, not a publication requirement. Eight is a reasonable initial navigation cap, not a measured engagement optimum.

The current website displays all supplied gallery images. Listing cards crop to 16:9 with 640×360 image attributes. Detail galleries use 1080×720 attributes and can occupy 500–600 CSS pixels in height on large screens. Both components already support an “Images available on request” state. Image loading is incremental, so the cap primarily improves selection and browsing; it should not be presented as an eight-image initial-download saving.

I ran `gpt-5.6-terra`, high image detail, on 202 original images: 108 images covering 12 complete galleries across four gallery-size bands, the largest 65-image gallery, and 29 additional cases selected from captions mentioning signs, contacts, blur, or ordinary signage. The 12 galleries were deterministically sampled; the challenge and largest-gallery subsets were deliberately selected. This is a design pilot, not a representative prevalence estimate or an accuracy benchmark. It underrepresents property types such as Shed and BTS. All 202 were inspected in contact sheets, with originals and enlarged sign regions examined for selected suspicious cases. This assistant visual review is not an independently annotated ground-truth dataset.

The model returned 161 ALLOW, 35 BLOCK, and six REVIEW decisions. All 202 completed. Thirteen initial model-side URL fetch failures succeeded when the same locally downloaded original bytes were submitted directly. Failures were never treated as approval. The recorded model quality tiers were 48 T1, 136 T2, 11 T3, and seven UNUSABLE; these include blocked images and do not describe the eligible pool alone.

Several inspected cases matter to the design:

| Warehouse / image | Observation | Consequence |
| --- | --- | --- |
| 702 / 2063 | A useful building photo contains a clear letting/contact board. | Block despite otherwise usable photographic quality. |
| 1111 / 4088 | A small enterprise board has a contact line visible on enlargement; the model requested review. | Inspect original detail; do not approve because a thumbnail hides digits. |
| 2017 / 9867 and 9868 | One view includes a letting board; a different framing of the same building leaves it outside the image. | Approval belongs to each image, not the whole warehouse or all similar views. |
| 2619 / 15118 | A phone number is painted directly on a shutter. | Detection must cover walls, gates and watermarks, not just freestanding boards. |
| 2150 / 10843 and 10852 | A suspected roadside letting placard is actually food advertising. Image 10852 also has a different, partly cropped letting sign at its left edge. | Model evidence locations can be wrong. Review the whole original, not just its nominated crop; ordinary signs must not automatically fail. |
| 1295 / 5318; 2297 / 12192 | Loan advertising on a pole and a lift-service contact notice trigger review. | Decide whether all third-party numbers are forbidden or only owner/broker contacts. Ownership cannot reliably be inferred from pixels. |
| 2563 / 14590 | A 319×196 source was rated T1. | Use decoded dimensions to constrain VLM quality scores. |
| 839 / several images | The gallery mostly consists of small or blurry but recognizable photos. | Keep weaker approved images to reach four; choose clearer small images before blurrier alternatives. |
| 2102 / entire gallery | All ten photos are exterior/drone views. | Reallocate indoor slots to useful outdoor views; do not invent balance. |
| 518 / 1007 | Extreme blur is contact-safe but not useful. | ALLOW alone is insufficient; UNUSABLE must still be excluded. |
| 460 / 754 | An allowed exterior contains a small sign whose purpose/contact content remains uncertain on inspection. | Retain as a challenge for independent review, not evidence of a confirmed unsafe approval or proof of safety. |

For this pilot, the conservative contact policy covers readable non-WareOnGo contact numbers without trying to determine their owner. The prompt also covers email addresses, contact websites/QR routes, and sale/lease solicitation. These broader rules are proposed policy choices, not an assumption that the user has approved every category. Ordinary company names, plot/dock numbers, vehicle plates, and measurements are not automatically forbidden. WareOnGo contact details require a verified allowlist, not recognition of a logo alone.

The selection scaffold separates the hard approval gate from photographic ranking:

1. Start from the warehouse's current canonical media references. Only use a current ALLOW decision, or an authorized manual approval bound to the same source version. Missing, pending, failed, ambiguous, blocked, document and unknown items do not enter the photo pool. Do not substitute unrelated photos when the pool is empty.
2. T1 means clear and representative; T2 means ordinary but useful; T3 means weak but recognizable; UNUSABLE means no useful visual information. Judge photographic quality rather than whether the building is old, occupied, unfinished, or inexpensive.
3. Apply objective source-size checks. In this pilot, a longest edge below 640 pixels caps the photo at T3; 640–959 caps it at T2. A source unable to provide a native 640×360 crop loses cover preference. These are provisional website-based thresholds; they do not guarantee that a large photo is sharp. Prefer actual delivered-variant dimensions too when implementing production readers.
4. Remove exact duplicates. Rank T1/T2 photos, preferring useful overall views and varied view types, and take up to eight. Balance indoor/outdoor within the available useful pool; a 3/5 or 0/8 split is valid. Preserve existing scene classifications for this decision; the new model's scene opinion is diagnostic and must not silently rewrite them.
5. If fewer than four useful photos remain, add the best approved T3 photos until four or exhaustion. Do not add weak photos simply to reach eight or enforce a balanced split. A gallery of five good photos stays at five even if twenty poor ones exist.
6. Put the best available representative overview first. Prefer a facade, interior overview, yard or land view over a washroom, staircase or small detail. Stable tie-breaking prevents arbitrary reshuffling. With only weak safe images, show those; with only one to three, show that count. With none, use the existing empty state and surface the shortage to staff.

The dimension checks downgraded six model tiers, including three contact-blocked images. Effective totals became 47 T1, 131 T2, 17 T3 and seven UNUSABLE. Exact-content hashes are supported in the selector. A simple dHash diagnostic found zero close pairs at the chosen threshold despite visibly repetitive galleries; it is not adequate proof that near-duplicate detection works. Keep approximate duplicate removal conservative until validated. Prefer distinct building views and avoid filling the gallery with office/washroom repetitions even when technically clear.

The simulated counts below use model predictions and dimension guards, without treating unresolved visual-review concerns as final human decisions. These are illustrative selections, not approved public galleries.

| Warehouse | Current images | Proposed count | Indoor / outdoor | Notes |
| --- | ---: | ---: | --- | --- |
| 1111 | 2 | 1 | 0 / 1 | One image awaiting contact review. |
| 839 | 5 | 4 | 2 / 2 | One ordinary photo plus three small/weak fallbacks. |
| 1265 | 6 | 5 | 3 / 2 | Layout excluded from the photo gallery. |
| 702 | 7 | 6 | 5 / 1 | Letting-board image excluded. |
| 2102 | 10 | 8 | 0 / 8 | Entirely exterior; view similarity needs further work. |
| 2017 | 8 | 7 | 6 / 1 | Contact-bearing framing excluded. |
| 1061 | 17 | 8 | 4 / 4 | Balanced useful pool available. |
| 1295 | 65 | 8 | 4 / 4 | Large gallery no longer overwhelms navigation. |

Across the 12 complete non-stress galleries, caps of four, six and eight selected 40, 55 and 66 photos respectively. Three galleries remained below four with every cap. Raising a maximum cannot solve sparse input; lowering it to four would also discard useful breadth from larger listings. Start with soft four / maximum eight, then assess customer behavior and staff review after rollout.

Keep the product schema small. The proposed additions to the existing image table are:

| Column | Purpose |
| --- | --- |
| `websiteDecision` | PENDING, ALLOW, BLOCK or REVIEW; default PENDING, with a database constraint. |
| `websiteQualityTier` | Nullable T1, T2, T3 or UNUSABLE; database-constrained. |
| `websiteAssessment` | JSONB containing reasons, evidence regions, view type, cover suitability, dimensions, source checksum/revision, model and prompt/policy versions. Do not store transcribed phone numbers. |
| `websiteAssessedAt` | Timestamp of the completed automated assessment. |
| `websiteOverride` | Nullable JSONB with an authorized review decision, optional tier correction, reason, reviewer, time and source revision. Automated retries cannot overwrite it. |

These are result/review columns, not a complete worker scheduling schema. The current application has cron-triggered, leased label/document/WebP stages; it does not already have an event queue for these assessments. Production execution needs durable retry/claim state as well. Reuse the existing lease/fencing approach for an initial worker, or put that state in a small durable jobs queue when wiring event-driven processing. Decide that implementation explicitly before adding execution fields; do not silently reuse a label/WebP lease for a concurrent website-assessment job. A duplicate enqueue must not cause duplicate final publication, and a stale worker must not overwrite a newer result.

Neither `Warehouse.media`, the original image storage, existing scene labels/captions, nor JPEG/WebP URLs need replacing. Gallery membership and order can be computed from current image rows, rather than adding another stored array to keep synchronized. Approval is website-specific; dashboard/PPT readers keep their existing behavior. Manual hide must be immediately effective, survive automated retries, and be tied to source identity. A manual allow corrects a reviewed false positive; a quality fallback never does.

Proposed implementation sequence:

1. Freeze the contact policy and broaden this evaluation to an independently reviewed set of roughly 500 images, spanning PEB/RCC/Shed/BTS, sparse galleries, several regions/languages, portrait photos, tiny distant signs, watermarks, painted numbers, benign signage and known unsafe cases. Keep a holdout set separate from prompt tuning. Measure unsafe approvals, false blocks, review volume, quality-ranking agreement and warehouse coverage separately. Do not turn model confidence into a safety guarantee.
2. Add the result columns with safe defaults and constraints. Build a resumable shadow backfill that prioritizes public listings and reads original image detail. Use bounded concurrency, download/decode limits, retry with local original bytes, and targeted OCR/crop review for suspected text. An OCR miss is not clearance. Record model/policy/source versions; no VLM call belongs in a website request.
3. Connect forward processing to image registration in both upload backends. New images remain PENDING until assessed; continue serving already approved images. Use durable jobs or the existing claim pattern with bounded retries and a reconciliation backstop. Assessment can run independently of compression once the original exists. Keep objects immutable, or invalidate results and overrides when replacing their contents. URL equality alone is not sufficient proof of unchanged pixels.
4. Add a focused staff review screen showing the original, highlighted evidence, decision/reason, quality, and proposed gallery/cover. Allow corrections and expose warehouses with fewer than four approved photos. Resolve classifier disagreements explicitly. Validate the automatic selections against this screen before public cutover.
5. Add one website-specific selector at the public API boundary, applied to list/detail/related-card consumers. Sanitize `images`, legacy `photos`, and `photosWebp` consistently, preserving correspondence and order. Do not merely filter React elements while returning rejected originals in JSON. Missing assessment data or a failed database read must not activate a raw-image fallback. Explicit `images: []` stays empty.
6. Update every static consumer: listing covers, editorial/overview variants, image sitemaps, structured data, OG images, and authored featured images. Audit featured assets separately where no image-table association exists. Version/invalidate API caches and rebuild/purge generated pages and disallowed generated covers on cutover. Later review changes must trigger the same invalidation/rebuild path; source-URL-only cover caches do not track an approval change. Ordinary WebP failure may fall back only to the same approved original. A future redacted derivative would require separate approval and must never fall back to its unredacted source.
7. Verify on complete warehouse fixtures and a staging build, then enable public selection after acceptable backfill coverage and reviewed examples. Test all-blocked, all-pending, mixed good/weak, one-sided scenes, zero/one/three photos, duplicates, original replacement, retries, stale jobs, manual decisions and cached/static pages. Monitor review/failure backlog and below-four/zero-photo counts. A rollback should retain the approval gate; if a reader is broken, use an empty placeholder instead of restoring rejected photos.

Public R2 original URLs will still exist because originals are retained. This proposal removes those images from website responses, pages and generated derivatives; it is not a storage-access revocation or removal from previously indexed third-party caches.

The local scaffold consists of [inventory](../scripts/evalWebsiteImageInventory.cjs), [model evaluation](../scripts/evalWebsiteImages.cjs), [prompt/schema/selection policy](../scripts/lib/websiteImageEvaluation.cjs), [HTML and contact-sheet report](../scripts/reportWebsiteImageEval.cjs), and [16 selector tests](../tests/image-pipeline/website-image-eval.cjs). All 16 pass. No production application imports these modules. Model outputs stay separate from derived dimension-adjusted tiers. The evaluation's local resume cache is for a frozen sample; use a fresh output directory when sources change, and implement source-version validation before adapting it to production.

Artifacts: [interactive review](/tmp/wareongo-website-image-eval/pilot/review.html), [summary](/tmp/wareongo-website-image-eval/pilot/summary.json), and [inventory](/tmp/wareongo-website-image-eval/inventory.json). The `/tmp` files are local and ephemeral; keep them private and copy them to a durable private evaluation location before relying on them for a later rollout.

To rerun the selection tests or regenerate the report without network/model calls, run from the dashboard backend:

```sh
node tests/image-pipeline/website-image-eval.cjs
node scripts/reportWebsiteImageEval.cjs /tmp/wareongo-website-image-eval/sample.json /tmp/wareongo-website-image-eval/pilot
```

The model runner defaults to a dry run. A deliberate model pass uses `--run-model`; `--inline` sends cached original bytes and avoids model-side URL fetch failures:

```sh
node --max-old-space-size=512 scripts/evalWebsiteImages.cjs --sample=/tmp/wareongo-website-image-eval/sample.json --output=/tmp/wareongo-website-image-eval/pilot --run-model --inline
```

Relevant existing implementation references: website frontend `src/lib/warehouseImages.ts`, `src/services/warehouseAPI.ts`, `src/components/WarehouseCard.tsx`, `src/components/WarehouseImageCarousel.tsx`, `src/lib/listingCover.server.mjs`, `src/lib/overviewImages.server.mjs`, `scripts/generate-sitemap.mjs`; website backend `services/warehouseService.js`, `controllers/warehouseController.js`, `services/imagePipelineRepository.cjs`; dashboard backend `src/models/imagePipelineRepository.cjs` and `src/services/imageLabelService.js`.
