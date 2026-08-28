const sharp = require('sharp');

/**
 * Fixture photographs, generated rather than committed.
 *
 * The deck builders fetch every photo over HTTP through `src/ppt/utils/image.js`,
 * so the harness serves these from a local origin instead of stubbing that
 * module out — the real fetch, the real EXIF handling and the real
 * dimension-reading all run.
 *
 * Bytes are a pure function of the label, which is what makes a rendered slide
 * comparable between runs.
 */

/** FNV-1a. Stable across runs and platforms. */
function hashString(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Raw RGB pixels: a flat colour with a lighter diagonal band and a pale border.
 * Distinct enough that a human can tell two fixtures apart on a slide, and far
 * from uniform — a slide showing one of these cannot be mistaken for a blank
 * slide by the variance check in render.js.
 */
function rawPixels({ width, height, label }) {
  const h = hashString(label);
  const base = { r: 70 + (h & 0x7f), g: 70 + ((h >>> 8) & 0x7f), b: 70 + ((h >>> 16) & 0x7f) };
  const slope = 1 + (h % 5) / 2;
  const bandWidth = Math.max(24, Math.round(width / 12));
  const data = Buffer.alloc(width * height * 3);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      const onBorder = x < 8 || y < 8 || x >= width - 8 || y >= height - 8;
      const onBand = Math.abs((x - y * slope) % (bandWidth * 3)) < bandWidth;

      let { r, g, b } = base;
      if (onBand) { r = Math.min(255, r + 60); g = Math.min(255, g + 60); b = Math.min(255, b + 60); }
      if (onBorder) { r = 232; g = 232; b = 232; }

      data[i] = r; data[i + 1] = g; data[i + 2] = b;
    }
  }

  return { data, info: { width, height, channels: 3 } };
}

/**
 * Encode a fixture photo.
 *
 * @param {object} opts
 * @param {string} opts.label
 * @param {'jpeg'|'png'} [opts.format]
 * @param {number} [opts.width]
 * @param {number} [opts.height]
 * @param {number} [opts.orientation] - EXIF Orientation (1-8) to stamp on a JPEG.
 *   Anything other than 1 is what a phone upload carries, and the reason
 *   `normalizeImageBuffer` re-encodes: PowerPoint and LibreOffice both ignore the
 *   tag, so an un-normalised photo lands on the slide rotated.
 * @returns {Promise<Buffer>}
 */
async function photoBuffer({ label, format = 'jpeg', width = 1600, height = 1200, orientation } = {}) {
  const { data, info } = rawPixels({ width, height, label });
  let pipeline = sharp(data, { raw: info });

  if (orientation && format === 'jpeg') {
    // Writes the tag without touching the pixels — exactly the state a phone
    // photo arrives in.
    pipeline = pipeline.withMetadata({ orientation });
  }

  return format === 'png'
    ? pipeline.png({ compressionLevel: 6 }).toBuffer()
    : pipeline.jpeg({ quality: 82 }).toBuffer();
}

module.exports = { photoBuffer, hashString };
