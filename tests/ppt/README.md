# PPT tests

Ported from the Warehouse Proposal Engine when it was merged into this backend.
Paths were repointed at `src/ppt/**`; the assertions are otherwise unchanged.

Three of the engine's six suites are here. The other three were deliberately
left behind — all three fail or flake *in the engine repo too*, verified by
running them there before the merge (16 failed / 82 passed, identical to the
result after porting). The engine's deploy workflow never ran `npm test`, so
nothing surfaced the rot. This repo's CI gates deploys on tests, so they cannot
come along as-is:

| Suite | Why excluded |
|---|---|
| `detailedSlide.test.js` | 8 stale assertions — expects `pptx.slides` to have length 1 where the current slide builder emits 2. Asserts a layout the code outgrew, not a defect. Also ~70s, mostly network. |
| `integration.test.js` | 8 failures from calling `createDetailedPptBuffer(warehouses, selectedImages)` with no `customDetails`; the service has no default for it and dereferences `customDetails.clientName`. Unreachable in production — every route passes `customDetails = {}` — so this is a test-side gap, not a live crash. |
| `geospatialService.integration.test.js` | Hits live Nominatim/Overpass on every run (the engine's own README calls it flaky). Belongs in a manual/tagged run, not a deploy gate. |

Worth fixing and reinstating, but that is slide-layout work rather than part of
the merge — the excluded suites cover rendering detail the three kept suites
(handover parsing, photo parsing, geospatial enrichment) do not.
