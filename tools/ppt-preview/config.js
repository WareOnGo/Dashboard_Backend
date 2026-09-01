const path = require('path');

/**
 * Paths, ports and the variant list. Side-effect free so both the preview CLI
 * and the eval runner can require it without ordering concerns.
 */

const harnessRoot = __dirname;
const backendRoot = path.resolve(harnessRoot, '..', '..');

/**
 * Every deck the backend can build, keyed by the `variant` string
 * PptGenerationService.createBuffer takes.
 *
 * `slides(warehouses)` is how many slides the deck should contain. It takes the
 * warehouse array rather than a count because one variant's page count depends
 * on the rows themselves, not just how many there are. All of these were
 * measured against the real builders — re-derive with `npm run ppt:slides` after
 * an intentional layout change rather than reading them off the slide code:
 *
 *   standard   3 + n            title + index + n property slides + contact
 *   v2         3 + n            title + index + n property slides + POC
 *   v3         3 + n + p        title + index + a details slide per property,
 *                               plus a photos slide for each of the p with
 *                               photographs, + POC.
 *                               The overview map adds one more, but only when
 *                               Mapbox is reachable — these runs block it, so
 *                               the counts here are the offline shape.
 *   godamwale  2 + n            title + index + n property slides
 *   tci        2 + n + p        baked title + a details slide per property, plus a
 *                               photos slide for each of the p with photographs,
 *                               + baked thank-you
 *   detailed   2 + 3a + 2b      title + closing, then three pages per warehouse
 *                               with photos (a) and two for one without (b)
 */
// Mirrors isImageUrl in src/ppt/slides/tci/detailedSlideTci.js: a row can carry a
// photos value that holds no usable image (a PDF, say), and the deck builders
// count images, not URLs.
const IMAGE_URL_RE = /\.(jpe?g|png|gif|webp|bmp)(?:$|\?)/i;
const imagePhotoCount = (w) => String(w.photos || '')
    .split(',')
    .map((u) => u.trim())
    .filter((u) => IMAGE_URL_RE.test(u))
    .length;
const hasPhotos = (w) => imagePhotoCount(w) > 0;

const VARIANTS = {
  standard: {
    label: 'standard',
    slides: (warehouses) => 3 + warehouses.length,
    network: false,
  },
  v2: {
    label: 'v2 (sidebar layout)',
    slides: (warehouses) => 3 + warehouses.length,
    network: false,
  },
  v3: {
    label: 'v3 (TCI columns, photos slide, per-site connectivity)',
    // cover + index + POC, then per warehouse: specification, photographs (only
    // when it has any), and connectivity. The connectivity slide is skipped only
    // when a warehouse has neither proximity data nor a map, which does not happen
    // once the proximity backfill has run.
    slides: (warehouses) => 3 + warehouses.length
        + warehouses.filter(hasPhotos).length
        + warehouses.length,
    // Fetches an overview map plus one street map per warehouse from Mapbox.
    // Refused in these runs, so the counts above are the offline shape and the deck
    // is asserted to survive without any of them.
    network: true,
  },
  godamwale: {
    label: 'Godamwale',
    slides: (warehouses) => 2 + warehouses.length,
    network: false,
  },
  tci: {
    label: 'TCI',
    // A details slide per property, plus a photos slide only for those that have
    // photographs — a property without any contributes one slide, not two.
    slides: (warehouses) => 2 + warehouses.length + warehouses.filter(hasPhotos).length,
    network: false,
  },
  detailed: {
    label: 'detailed',
    // The photo page is omitted for a warehouse with no photographs, so this
    // cannot be expressed as a multiple of the warehouse count.
    slides: (warehouses) => 2 + warehouses.reduce((total, w) => total + (hasPhotos(w) ? 3 : 2), 0),
    network: true,
  },
};

module.exports = {
  harnessRoot,
  backendRoot,
  VARIANTS,
  VARIANT_NAMES: Object.keys(VARIANTS),

  paths: {
    out: path.join(harnessRoot, 'out'),
    lib: path.join(harnessRoot, 'lib'),
  },

  /** Rasterisation settings. 120 dpi ≈ 1600px wide for a 13.3in slide. */
  render: {
    dpi: Number(process.env.PPT_PREVIEW_DPI || 120),
    // LibreOffice is slow to start and slower on an image-heavy deck.
    convertTimeoutMs: 180_000,
    rasterTimeoutMs: 120_000,
  },

  previewPort: Number(process.env.PPT_PREVIEW_PORT || 4900),
  imagePort: Number(process.env.PPT_PREVIEW_IMAGE_PORT || 4901),
};
