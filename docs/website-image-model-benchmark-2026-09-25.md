Luna and Terra website-image benchmark, 25 September 2026.

Luna is a viable candidate for the next evaluation round. This run does not show that Terra is a safer automatic approver: a disagreement check found a readable business phone number that Luna blocked and Terra allowed. Terra was more conservative about photo quality, which helped avoid at least one poor gallery selection. Keep the proposed review state and deterministic image-size checks with either model.

Both models were freshly run on the same 202 cached original images, using the unchanged `website-approval-eval-v1` prompt/schema, high image detail, inline original bytes, and four concurrent requests per model. Model names were `gpt-5.6-luna` and `gpt-5.6-terra`; no model-specific reasoning setting was supplied. Input content hashes match for every pair. Each model received 541,756 input tokens. All 404 image assessments completed successfully. An initial one-image sandbox connection failure was retried after network access was granted; it produced no usable model result and is excluded from the result metrics.

This sample contains 12 complete galleries (108 images), one deliberately selected 65-image gallery, and 29 targeted challenge images. It is useful for comparing behavior, but not representative enough to estimate production error rates. These are fresh Terra results; they replace neither the earlier pilot files nor their historical counts.

| Measurement | Luna | Terra |
| --- | ---: | ---: |
| Images evaluated | 202 | 202 |
| ALLOW | 160 | 160 |
| BLOCK | 34 | 38 |
| REVIEW | 8 | 4 |
| T1 / T2 / T3 / UNUSABLE, raw model ratings | 66 / 129 / 4 / 3 | 46 / 145 / 6 / 5 |
| Median successful API request | 5.43 seconds | 4.93 seconds |
| Mean successful API request | 10.44 seconds | 9.16 seconds |
| 95th-percentile successful API request | 45.46 seconds | 32.72 seconds |
| Input tokens | 541,756 | 541,756 |
| Output tokens | 48,457 | 32,828 |

Request times exclude preparation, image decoding and any earlier failed attempts. The runs overlapped, and service latency varied considerably; these observations do not establish an inherent speed advantage. Token counts are measured usage, not a provider invoice or a pricing estimate.

Equal ALLOW totals hide different decisions. The models agreed on the exact decision for 191/202 images (94.6%). Six images crossed the allow/withhold boundary: three allowed only by Luna and three allowed only by Terra. They both allowed 157 images. Agreement measures consistency between models, not correctness.

Before looking at the new benchmark outputs, I froze a small reference set using prior visual review and new image-only contact sheets: 23 clearly restricted images, 12 apparently clean property photos, and four unresolved cases. This is an assistant-reviewed sanity check, not independent expert ground truth or a held-out statistical benchmark. Both models withheld all 23 restricted images and allowed all 12 clean examples. Luna used 21 blocks and two reviews for the restricted set; Terra used 22 blocks and one review. Unresolved cases were not scored as correct or incorrect.

I then inspected all 11 decision disagreements, using originals and enlarged regions where useful. Findings from this later review are kept separate from the frozen reference scores:

| Image / warehouse | Luna | Terra | Visual finding |
| --- | --- | --- | --- |
| 13661 / 2474 | BLOCK | ALLOW | The lower storefront banner has a readable mobile-contact line. Confirmed Terra miss under the benchmark's third-party-contact rule; its T1 rating would also make the image eligible for website selection. |
| 10843 / 2150 | ALLOW | BLOCK | Terra's nominated “letting” placard is food advertising. Its stated blocking evidence is incorrect. No confirmed readable contact route was found in this inspection. |
| 10852 / 2150 | ALLOW | BLOCK | Terra again points to food advertising. A separate partly cropped/reflected sign remains suspicious at the left edge. Keep unresolved; incorrect evidence for one region does not establish safety of the entire image. |
| 10847 / 2150 | REVIEW | BLOCK | Enlarged upper-window signage shows letting text. Both models correctly withhold it, with different certainty. |
| 3774 / 1061 | ALLOW | REVIEW | The cabinet sheets look like internal charts/records. No readable contact route was established; Terra's concern is based on unreadable text alone. |
| 14966 / 2606 | REVIEW | ALLOW | Main-road and plot labels are benign, but painted digits on the gate remain ambiguous. No complete phone number was confirmed. |
| 13356 / 2438 | REVIEW | ALLOW | A company board is partly obscured by foliage. No readable contact number was confirmed; retain as an unresolved challenge. |
| 15211 / 2629 | BLOCK | REVIEW | A storefront fascia has a contact/email line. Both withhold it. Luna's highlight coordinates point too low despite its useful decision. |
| 15215 / 2629 | REVIEW | BLOCK | Storefront email/mobile contact text is visible; both withhold. The tiny source is also downgraded by the dimension guard. |
| 5334 / 1295 | REVIEW | BLOCK | The QR poster appears to be for Paytm payment. The broad QR rule needs clarification: a payment code is not automatically proof of an owner/broker lead route. |
| 1007 / 518 | REVIEW | BLOCK | Extreme blur is UNUSABLE for both models, so this decision difference has no gallery consequence. |

The confirmed missed number is a business contact; its owner cannot be determined from the image. The benchmark retained the earlier conservative rule covering third-party contact routes. That policy is broader than an owner-only restriction. The finding should not be described as a verified owner number or used to silently expand production policy.

Luna tends to award higher quality tiers. Among the 157 photos both models allowed, after identical dimension guards:

| Effective quality tier | Luna | Terra |
| --- | ---: | ---: |
| T1 | 48 | 38 |
| T2 | 101 | 109 |
| T3 | 8 | 10 |

They agreed on the effective quality tier for 129/157 of these commonly allowed images. A useful concrete difference is image 12203 in warehouse 2297: a dark equipment-room detail. Luna rated it T2 and selected it among the eight images. Terra rated it T3 and omitted it because clearer alternatives were available; that is the preferable website outcome in my visual review. Image 5359, a blurred and obstructed washroom doorway, was similarly T2 for Luna and T3 for Terra, although neither selected it for that warehouse.

The soft-four/maximum-eight selector produced the same image count for every one of the 13 complete galleries with either model. Image membership differed in four galleries and covers differed in five. Both selected 74 photos across these galleries, leaving the same three sparse galleries below four. Thus the count recommendation survives this comparison, but ranking calibration materially changes what visitors see.

Both models sometimes returned `coverSuitable: true` for restricted images (20 such responses for Luna, 23 for Terra). The deterministic approval gate correctly prevents this field from reviving them. Likewise, approximate evidence boxes must be treated as review aids rather than exact redaction coordinates.

The fresh Terra run also changed eight decisions relative to its earlier pilot, including image 13661 changing from BLOCK to ALLOW. The earlier pilot predominantly used image URLs while this benchmark used original bytes, so this is not a perfectly controlled repeatability test. It still demonstrates why one favorable earlier result should not be treated as a durable safety guarantee.

For the next iteration, keep Luna as the candidate primary model and tighten the quality examples for dark, blurred, obstructed and incidental detail photos. Preserve review for plausible contact risks. Refine ordinary-sign and payment-QR policy using the observed cases. Evaluate a larger independently reviewed holdout before deciding on automatic website publication. Terra can provide another opinion, but a Terra ALLOW must not automatically clear a Luna block/review; this run contains a concrete example where that would publish contact details. There is no evidence here that calling both on every image is necessary.

No database, R2 object, schema, application route or production selection changed. The new [comparison script](../scripts/compareWebsiteImageModels.cjs) validates identical source hashes, sample, prompt/schema versions and completed runs before reporting comparisons. It keeps pre-comparison reference checks separate from later visual findings.

Artifacts: [interactive side-by-side review](/tmp/wareongo-website-image-eval/luna-terra-benchmark/comparison.html), [machine-readable comparison](/tmp/wareongo-website-image-eval/luna-terra-benchmark/comparison.json), [frozen reference set](/tmp/wareongo-website-image-eval/luna-terra-benchmark/reference.json), [later visual findings](/tmp/wareongo-website-image-eval/luna-terra-benchmark/visual-review.json). Images and raw predictions are local private evaluation files under the same directory; `/tmp` is ephemeral.

Regenerate the comparison locally, without API calls:

```sh
node scripts/compareWebsiteImageModels.cjs /tmp/wareongo-website-image-eval/luna-terra-benchmark
```
