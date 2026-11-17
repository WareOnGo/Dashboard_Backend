# V3 PPT size and assembly benchmark — 2026-09-24

Measured result: a five-option deck with six photos per option shrank from 25.28 MB to 5.60 MB using the existing WebPs. Median local assembly dropped from 1.14 s to 0.20 s, excluding network and database access.

All decks use five options, the real V3 slide builder, real warehouse image bytes, synthetic property details, an actual cached 1.126 MB overview map, branding and contact slides. V3 also embeds one repeated photo strip per option; those bytes are included. MB means 1,000,000 bytes.

| Scenario | Originals (MB) | Existing WebPs with fallback (MB) | Reduction | Original assembly (s) | WebP assembly (s) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4 photos per option | 19.70 | 4.79 | 75.7% | 0.91 | 0.16 |
| 6 photos per option | 25.28 | 5.60 | 77.9% | 1.14 | 0.20 |
| 10 photos per option | 48.29 | 7.69 | 84.1% | 1.93 | 0.28 |
| 12 photos per option | 50.88 | 8.45 | 83.4% | 2.04 | 0.30 |
| 6 largest original photos per option (stress) | 65.48 | 5.98 | 90.9% | 2.43 | 0.21 |
| 12 largest WebP photos per option (stress) | 62.58 | 9.75 | 84.4% | 2.45 | 0.35 |
| 12 photos + 1 large document per option (stress) | 65.95 | 9.39 | 85.8% | 2.57 | 0.34 |
| 12 photos + 1 original document fallback per option (stress) | 65.95 | 23.52 | 64.3% | 2.66 | 0.90 |

The benchmark reused the earlier deterministic 80-image sample: 76 photographs and four documents. It fetched the stored original/WebP pairs afresh. 79 had ready WebPs; one photograph was still PENDING, so its original remained in the relevant decks. No image was silently removed to obtain the smaller sizes.

The drawing stress case repeats the largest sampled document once for each of the five synthetic options. It is a size stress test, not a measured customer deck or a drawing-quality check. Normal and compressed decks use exactly the same selected image identities and order.

**Encoding and timing:** Existing WebPs are embedded without decoding/re-encoding. Base64 conversion and PPTX packaging still happen. In the six-photo case, cumulative image-loader preparation for the compressed deck was approximately 2.7 ms. The selective database query took a median 161 ms on an established connection (three measured queries after connection startup). Assembly timings are medians of five alternating runs after warmup, using cached bytes from memory. They exclude database, image/map downloads and HTTP response delivery; they are not production end-to-end response times.

The source downloads, performed with concurrency three, had medians of 0.65 s/original and 0.53 s/WebP. These are environment-specific, mixed cold/warm fetches, not a controlled production-network speedup estimate. Smaller payloads should reduce transfer work. Test the completed endpoint before quoting total download latency.

**Checks passed:** Every selected photograph is present by content hash; photo-copy and document counts match; the overview map is present; embedded WebP parts contain actual WebP bytes, have .webp filenames and use image/webp content types. Native WebPs are not disguised as JPEGs. Actual PowerPoint open/save compatibility remains a separate validation step.

The fixture includes current template assets and the overview map. Optional proximity and client-routing maps are excluded. More photos, extra maps, larger documents or more original-image fallbacks can take another deck over 25 MB. The observed six-photo reduction is about 78%; this is sample evidence, not a promise for every export.

Measured on Intel(R) Core(TM) i7-8850H CPU @ 2.60GHz, Node v22.21.1.

Raw measurements: [report.json](../tools/ppt-preview/out/webp-size-2026-09-24T13-40-38-906Z/report.json).
Example compressed deck: [six photos per option](../tools/ppt-preview/out/webp-size-2026-09-24T13-40-38-906Z/6_photos_each-webp.pptx).

Reproduce from the local cache: `node scripts/benchmarkWebpPptV3.cjs`.
Refresh the read-only source sample: `node scripts/benchmarkWebpPptV3.cjs --fetch`.

Only the standalone benchmark script and local reports/artifacts were added. Application source, Supabase rows and R2 objects were not modified.
