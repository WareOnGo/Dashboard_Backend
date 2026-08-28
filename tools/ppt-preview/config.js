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
 *   godamwale  2 + n            title + index + n property slides
 *   tci        2 + 2n           baked title + a details and a photos slide per
 *                               property + baked thank-you
 *   detailed   2 + 3a + 2b      title + closing, then three pages per warehouse
 *                               with photos (a) and two for one without (b)
 */
const hasPhotos = (w) => typeof w.photos === 'string' && w.photos.trim().length > 0;

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
  godamwale: {
    label: 'Godamwale',
    slides: (warehouses) => 2 + warehouses.length,
    network: false,
  },
  tci: {
    label: 'TCI',
    // Two slides per property: the full-width specification table, then the
    // photographs. The photos slide is emitted even when a property has none.
    slides: (warehouses) => 2 + 2 * warehouses.length,
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
