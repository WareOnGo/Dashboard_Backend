# ppt-preview

Local preview and automated checks for the warehouse proposal decks
(`src/ppt/**`), including the deck-to-image step the standalone Warehouse
Proposal Engine had before PPT generation moved into this backend.

```bash
npm run ppt:preview -- v2            # generate, rasterise, open a contact sheet
npm run ppt:preview -- all           # every variant on one page
npm run ppt:eval                     # assertions over every variant
npm run ppt:slides                   # re-derive the expected slide counts
```

Needs LibreOffice and poppler for rasterisation:

```bash
sudo dnf install libreoffice-impress poppler-utils    # Fedora
sudo apt install libreoffice-impress poppler-utils    # Debian/Ubuntu
brew install --cask libreoffice && brew install poppler # macOS
```

`ppt:eval` still runs its XML checks without them (`--no-render`); `ppt:preview`
needs them.

## What it does

Decks are built **in process** through the real `PptGenerationService`, so the
variant switch, the id ordering and every builder under `src/ppt/**` are the code
under test. No HTTP, no auth, no Prisma by default — and no App Runner ~120s cap,
which is what makes a slow detailed deck workable here.

Two things are substituted:

- **Warehouses** come from `lib/fixtures.js` — deterministic rows in exactly the
  shape `WarehouseModel.findManyForPpt` returns (flat columns plus an included
  `WarehouseData`). `--db` swaps in real rows through Prisma.
- **The network** is refused except a local photo origin. The deck builders fetch
  every photograph over HTTP through `src/ppt/utils/image.js`, so the harness
  *serves* fixture photos rather than stubbing that module — the real fetch, the
  real EXIF handling and the real header parsing all run. Everything else is
  blocked at the `http`/`https` module and **recorded**, which is how a run can
  report that a detailed deck makes 7 third-party calls per warehouse.

## Preview

```
npm run ppt:preview -- <variant|all> [options]

  --ids 1,2,3        warehouse ids (default: every fixture)
  --count N          how many fixture warehouses (default 4)
  --db               real warehouses through Prisma instead of fixtures
  --online           allow outbound HTTP (the detailed deck's enrichment)
  --dpi N            rasterisation dpi (default 120)
  --port N           preview port (default 4900)
  --out DIR          keep artefacts here instead of a temp dir
  --no-open          don't launch a browser

  --no-commercials   rent shows "Available on Demand"
  --no-maps          Google Maps shows "Available on Demand"
  --no-poc           omit the closing WareOnGo POC slide
```

The page shows every slide as a PNG, the deck's slide count against what it
should be, embedded image count and dimensions, any placeholder leaks, blocked
outbound calls, and a `.pptx` download.

**Rebuild** on the page drops the `require` cache for `src/ppt/**` and rebuilds
without restarting, so editing slide code and clicking Rebuild shows the new
slides. Handy on a deck that takes 20 seconds to render.

## Checks

`npm run ppt:eval` runs two layers, for two very different costs.

**Reading the `.pptx` zip** (milliseconds, no system tools). A `.pptx` is a zip of
XML, so slide count, every line of text and every embedded image with its
dimensions are all cheap. This is where most of the value is:

| Check | Catches |
|---|---|
| slide count matches `config.js` | a slide silently disappearing |
| no placeholder values | `undefined` / `null` / `NaN` / `[object Object]` / `Invalid Date` reaching a client-facing deck |
| photographs embedded | a photo that was fetched but never made it onto a slide |
| display flags honoured | `--no-commercials` / `--no-maps` / `--no-poc` not actually redacting |
| EXIF rotation baked in | a phone photo landing sideways — PowerPoint and LibreOffice both ignore the Orientation tag, so the builder has to bake it into the pixels |
| survives a 404 photo | one dead URL taking down a whole deck |
| same text on a rebuild | non-determinism that would make everything above untrustworthy |
| no outbound calls | a variant quietly acquiring a network dependency |

**Rasterising** (seconds, LibreOffice + poppler) catches what only pixels can: a
slide that renders blank. Blankness is measured as near-zero greyscale standard
deviation — text alone lifts a slide well clear of the threshold.

Exit code is non-zero on failure, so it can gate a change to slide code.
`out/eval/report.html` is the same contact sheet the preview serves, with the
results above it.

### Slide counts are measurements

`VARIANTS[x].slides(warehouses)` in `config.js` was derived by building real
decks, not by reading the slide code, and the eval asserts it exactly. After an
intentional layout change, run `npm run ppt:slides` and update it. Note the
signature takes the warehouse array, not a count — the detailed deck emits three
pages for a warehouse with photographs and two for one without, so its page count
is not a multiple of anything.

## Regression guards

One real defect surfaced by this harness has since been fixed; the checks that
found it are kept:

- **`--no-commercials` did not redact the index slide.** `pptServiceV2` called
  `generateIndexSlideV2(pptx, warehouses)` without the display flags, and
  `indexSlideV2.js` rendered `ratePerSqft` unconditionally under "Quoted Monthly
  Rental". A v2 deck built with "Include rent / commercials" unticked in the
  dashboard's PPT modal therefore redacted the rent on each property slide and
  then printed every rate on the page right after the title. v2 is the only
  variant the frontend sends these flags for (`PptConfigModal.jsx`), so it was
  reachable in production. Fixed by threading `flags` through to the index slide.

  Guarded in two places, because they fail on different mistakes:
  `tests/ppt/commercialsRedaction.test.js` in the repo's own jest suite (so CI
  catches it — this harness is local-only), and `ppt:eval` end to end.

Note the shape of those checks. Each redaction check is paired with a **control**
asserting the rate *is* present when the flag is on: without it, a redaction check
could pass simply because the matcher never finds the rate anywhere. They also
match whole table cells rather than substrings, since a rate of 55 appears inside
an area of 155,000.

## Layout

```
config.js            paths, ports, variants, expected slide counts
preview.js           the dev CLI + contact-sheet server
eval.js              the assertion runner
slides.js            re-derive slide counts from real decks
lib/generate.js      drives the real PptGenerationService
lib/fixtures.js      deterministic warehouses, photo edge cases
lib/images.js        generated fixture photographs (incl. EXIF-rotated)
lib/imageServer.js   local origin the deck builders fetch photos from
lib/netGuard.js      refuses and records non-local HTTP
lib/pptx.js          reads a .pptx: slides, text, embedded media
lib/render.js        .pptx → PDF → PNG per slide, blankness check
lib/page.js          the contact sheet
```

`out/` holds rendered artefacts and is gitignored. `jszip` is required through the
backend's tree — it is pptxgenjs's own declared dependency, so it is present
wherever the deck builders are, and nothing here adds a package.

One note on LibreOffice: each conversion gets a private profile directory
(`-env:UserInstallation`). Without it a headless convert silently does nothing
when the developer already has LibreOffice open, and two runs cannot proceed in
parallel — the old engine script hit both.
