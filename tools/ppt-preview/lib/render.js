const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const sharp = require('sharp');
const { render: renderConfig } = require('../config');

const execFileP = promisify(execFile);

/**
 * Deck → PNG per slide.
 *
 * This is the piece the old proposal engine had and the merged backend lost:
 * LibreOffice converts the .pptx to PDF, pdftoppm rasterises each page. Both are
 * system binaries, so the harness reports them as missing rather than failing
 * obscurely when they are not installed.
 *
 * LibreOffice is given a private profile directory (`-env:UserInstallation`).
 * Without it, a headless convert silently does nothing when the developer
 * already has LibreOffice open — the same lock is shared — and two harness runs
 * cannot proceed in parallel. The old script hit both.
 */

/** Are the conversion binaries available? */
async function checkTools() {
  const results = {};
  for (const [name, args] of [['libreoffice', ['--version']], ['pdftoppm', ['-v']]]) {
    try {
      const { stdout, stderr } = await execFileP(name, args, { timeout: 20_000 });
      results[name] = { available: true, version: (stdout || stderr).trim().split('\n')[0] };
    } catch (error) {
      results[name] = { available: false, error: error.message.split('\n')[0] };
    }
  }
  results.ok = results.libreoffice.available && results.pdftoppm.available;
  results.hint = results.ok
    ? null
    : 'Install LibreOffice and poppler-utils (Fedora: sudo dnf install libreoffice-impress poppler-utils · Debian/Ubuntu: sudo apt install libreoffice-impress poppler-utils · macOS: brew install --cask libreoffice && brew install poppler)';
  return results;
}

/**
 * Rasterise a deck.
 *
 * @param {Buffer} buffer   - the .pptx
 * @param {object} [opts]
 * @param {string} [opts.outDir] - where to write; a temp dir by default
 * @param {string} [opts.name]   - basename for the artefacts
 * @param {number} [opts.dpi]
 * @returns {Promise<{dir: string, pptxPath: string, pdfPath: string,
 *                    slides: Array<{index: number, file: string, path: string, width: number, height: number, blank: boolean, stdev: number}>,
 *                    durationMs: number}>}
 */
async function renderToPngs(buffer, { outDir, name = 'deck', dpi = renderConfig.dpi } = {}) {
  const startedAt = Date.now();
  const dir = outDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-preview-'));
  fs.mkdirSync(dir, { recursive: true });

  const pptxPath = path.join(dir, `${name}.pptx`);
  fs.writeFileSync(pptxPath, buffer);

  // A private LibreOffice profile, discarded afterwards. See the note above.
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-profile-'));

  try {
    await execFileP('libreoffice', [
      `-env:UserInstallation=file://${profileDir}`,
      '--headless',
      '--norestore',
      '--convert-to', 'pdf',
      '--outdir', dir,
      pptxPath,
    ], { timeout: renderConfig.convertTimeoutMs });
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }

  const pdfPath = path.join(dir, `${name}.pdf`);
  if (!fs.existsSync(pdfPath)) {
    throw new Error(
      `LibreOffice produced no PDF for ${name}. This usually means another `
      + 'LibreOffice instance holds the profile lock, or the deck is malformed.',
    );
  }

  // Clear any PNGs from a previous run so a deck that lost slides does not
  // appear to still have them.
  for (const file of fs.readdirSync(dir)) {
    if (new RegExp(`^${name}-slide-\\d+\\.png$`).test(file)) fs.unlinkSync(path.join(dir, file));
  }

  await execFileP('pdftoppm', [
    '-png', '-r', String(dpi), pdfPath, path.join(dir, `${name}-slide`),
  ], { timeout: renderConfig.rasterTimeoutMs });

  const files = fs.readdirSync(dir)
    .filter((f) => new RegExp(`^${name}-slide-\\d+\\.png$`).test(f))
    .sort((a, b) => {
      const n = (s) => Number(s.match(/-slide-(\d+)\.png$/)[1]);
      return n(a) - n(b);
    });

  const slides = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const full = path.join(dir, file);
    const { width, height } = await sharp(full).metadata();
    // A slide that rendered as one flat colour has no standard deviation. That
    // is how a failed background, a missing image or an empty layout shows up in
    // pixels, and text alone is enough to lift it well clear of the threshold.
    const stats = await sharp(full).greyscale().stats();
    const stdev = stats.channels[0].stdev;
    slides.push({
      index: i + 1,
      file,
      path: full,
      width,
      height,
      stdev: Number(stdev.toFixed(2)),
      blank: stdev < 1.5,
    });
  }

  return { dir, pptxPath, pdfPath, slides, durationMs: Date.now() - startedAt };
}

module.exports = { renderToPngs, checkTools };
