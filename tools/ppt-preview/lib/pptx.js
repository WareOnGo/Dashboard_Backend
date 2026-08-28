const path = require('path');
const sharp = require('sharp');
const { backendRoot } = require('../config');

// jszip is pptxgenjs's own declared dependency, so it is installed wherever the
// deck builders are. Required through the backend's tree rather than assuming
// hoisting, and read-only here — nothing writes a .pptx except pptxgenjs.
const JSZip = require(path.join(backendRoot, 'node_modules/jszip'));

/**
 * Read a generated deck without rendering it.
 *
 * A .pptx is a zip of XML, so slide count, slide text and embedded media are all
 * available in milliseconds and with no LibreOffice. That makes the checks worth
 * asserting on in every run: whether a slide vanished, whether a field leaked
 * "undefined" onto a customer-facing deck, whether a photo actually made it in.
 *
 * Rasterisation (render.js) is for the things only pixels can answer.
 */

/** Slide XML files, in slide order (slide2 before slide10). */
function slideEntries(zip) {
  return Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const n = (s) => Number(s.match(/slide(\d+)\.xml$/)[1]);
      return n(a) - n(b);
    });
}

/** Text runs from one slide's XML, in document order. */
function textRuns(xml) {
  const runs = [];
  const pattern = /<a:t>([\s\S]*?)<\/a:t>/g;
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const text = match[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
    if (text.trim()) runs.push(text);
  }
  return runs;
}

/**
 * @param {Buffer} buffer - a .pptx
 * @returns {Promise<{slideCount: number, slides: Array<{index: number, text: string[], joined: string}>,
 *                    media: Array<{name: string, bytes: number}>, text: string}>}
 */
async function inspect(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const names = slideEntries(zip);

  const slides = [];
  for (let i = 0; i < names.length; i += 1) {
    const xml = await zip.file(names[i]).async('string');
    const text = textRuns(xml);
    slides.push({ index: i + 1, name: names[i], text, joined: text.join(' • ') });
  }

  const media = [];
  for (const name of Object.keys(zip.files)) {
    if (!/^ppt\/media\//.test(name) || zip.files[name].dir) continue;
    const data = await zip.file(name).async('nodebuffer');
    const entry = { name: path.basename(name), bytes: data.length, width: null, height: null };
    // Dimensions as embedded, which is how the EXIF fix is verifiable from the
    // outside: a phone photo tagged Orientation 6 has to arrive rotated (portrait
    // pixels), because PowerPoint ignores the tag it was carrying.
    try {
      const meta = await sharp(data).metadata();
      entry.width = meta.width ?? null;
      entry.height = meta.height ?? null;
      entry.format = meta.format ?? null;
      entry.orientation = meta.orientation ?? null;
    } catch {
      // Not an image sharp can read (a video poster, an EMF); size still counts.
    }
    media.push(entry);
  }
  media.sort((a, b) => a.name.localeCompare(b.name));

  return {
    slideCount: slides.length,
    slides,
    media,
    text: slides.map((s) => s.joined).join('\n'),
  };
}

/**
 * Placeholder values that must never reach a customer-facing slide.
 *
 * Word-bounded, and `null`/`NaN` are matched case-sensitively: "Null" appears in
 * legitimate prose ("Nullah Road") while the bare JavaScript spellings do not.
 * "N/A" is deliberately absent — it is a real, intentional value in these decks.
 */
const LEAK_PATTERNS = [
  { name: 'undefined', pattern: /\bundefined\b/ },
  { name: 'null', pattern: /\bnull\b/ },
  { name: 'NaN', pattern: /\bNaN\b/ },
  { name: '[object Object]', pattern: /\[object Object\]/ },
  { name: 'Invalid Date', pattern: /Invalid Date/ },
];

/**
 * Slides carrying a placeholder leak.
 * @returns {Array<{slide: number, leak: string, text: string}>}
 */
function findLeaks(inspection) {
  const found = [];
  for (const slide of inspection.slides) {
    for (const run of slide.text) {
      for (const { name, pattern } of LEAK_PATTERNS) {
        if (pattern.test(run)) found.push({ slide: slide.index, leak: name, text: run.slice(0, 120) });
      }
    }
  }
  return found;
}

/** True when `needle` appears anywhere in the deck's text. */
function containsText(inspection, needle) {
  return inspection.text.toLowerCase().includes(String(needle).toLowerCase());
}

module.exports = { inspect, findLeaks, containsText, LEAK_PATTERNS };
