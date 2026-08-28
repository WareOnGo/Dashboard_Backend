#!/usr/bin/env node
/**
 * Local deck preview — the "PPT to image" loop.
 *
 *   node tools/ppt-preview/preview.js v2
 *   node tools/ppt-preview/preview.js all --count 3
 *   node tools/ppt-preview/preview.js detailed --db --ids 1694,552
 *
 * Generates a deck in-process, converts it to PNGs, and serves a contact sheet
 * with a Rebuild button that reloads the slide code without restarting — so
 * editing something under src/ppt/ and clicking Rebuild shows the new slides.
 *
 * Options
 *   --ids 1,2,3         warehouse ids (default: every fixture)
 *   --count N           how many fixture warehouses to build (default 4)
 *   --db                load real warehouses through Prisma instead of fixtures
 *   --online            allow outbound HTTP (the detailed deck's enrichment)
 *   --dpi N             rasterisation dpi (default 120)
 *   --port N            preview port (default 4900)
 *   --out DIR           keep artefacts here instead of a temp dir
 *   --no-open           do not launch a browser
 *
 * Deck display flags, each redacting content the way the dashboard's PPT modal does:
 *   --no-commercials    rent shows "Available on Demand"
 *   --no-maps           Google Maps shows "Available on Demand"
 *   --no-poc            the closing WareOnGo POC slide is omitted
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { VARIANTS, VARIANT_NAMES, backendRoot, previewPort, render: renderConfig } = require('./config');
const { createSession } = require('./lib/generate');
const { renderToPngs, checkTools } = require('./lib/render');
const { inspect, findLeaks } = require('./lib/pptx');
const { renderContactSheet } = require('./lib/page');

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const has = (name) => argv.includes(`--${name}`);
const value = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const target = positional[0] || 'v2';
const wanted = target === 'all' ? VARIANT_NAMES : [target];

for (const variant of wanted) {
  if (!VARIANTS[variant]) {
    console.error(`Unknown variant "${variant}". Known: ${VARIANT_NAMES.join(', ')}, or "all".`);
    process.exit(1);
  }
}

const options = {
  ids: value('ids') ? String(value('ids')).split(',').map((s) => Number(s.trim())).filter(Boolean) : null,
  count: Number(value('count', 4)),
  useDb: has('db'),
  offline: !has('online'),
  dpi: Number(value('dpi', renderConfig.dpi)),
  port: Number(value('port', previewPort)),
  outDir: value('out') ? path.resolve(String(value('out'))) : null,
  open: !has('no-open'),
  customDetails: {
    commercials: !has('no-commercials'),
    mapsLocation: !has('no-maps'),
    pocSlide: !has('no-poc'),
  },
};

/**
 * Forget the deck-building modules so the next require reads the file again.
 * Scoped to src/ppt and the generation service — anything wider would also drop
 * the Prisma client and the harness's own state.
 */
function clearDeckModuleCache() {
  const roots = [path.join(backendRoot, 'src', 'ppt'), path.join(backendRoot, 'src', 'services', 'pptGenerationService.js')];
  let cleared = 0;
  for (const key of Object.keys(require.cache)) {
    if (roots.some((root) => key.startsWith(root))) {
      delete require.cache[key];
      cleared += 1;
    }
  }
  // generate.js holds a reference to the service class, so it goes too.
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.join(__dirname, 'lib'))) delete require.cache[key];
  }
  return cleared;
}

async function buildAll(session, dir) {
  const decks = [];

  for (const variant of wanted) {
    const spec = VARIANTS[variant];
    process.stdout.write(`  ${variant.padEnd(10)} generating… `);

    let deck;
    try {
      deck = await session.build(variant, { ids: options.ids, customDetails: options.customDetails });
    } catch (error) {
      console.log(`FAILED — ${error.message}`);
      decks.push({ variant, label: spec.label, error: error.message, slides: [] });
      continue;
    }

    const inspection = await inspect(deck.buffer);
    const leaks = findLeaks(inspection);
    const expected = spec.slides(deck.warehouses);

    process.stdout.write(`${(deck.buffer.length / 1024).toFixed(0)}kB, rendering… `);

    let rendered = { slides: [], durationMs: 0 };
    let renderError = null;
    try {
      rendered = await renderToPngs(deck.buffer, { outDir: dir, name: variant, dpi: options.dpi });
    } catch (error) {
      renderError = error.message;
    }

    const blank = rendered.slides.filter((s) => s.blank).map((s) => s.index);
    console.log(
      `${inspection.slideCount} slides (expected ${expected})`
      + `, ${inspection.media.length} images`
      + (leaks.length ? `, ${leaks.length} PLACEHOLDER LEAK(S)` : '')
      + (blank.length ? `, blank: ${blank.join(', ')}` : '')
      + (renderError ? `, render failed: ${renderError}` : ''),
    );

    decks.push({
      variant,
      label: spec.label,
      bytes: deck.buffer.length,
      warehouses: deck.warehouses.map((w) => ({ id: w.id, city: w.city, photos: w.photos ? w.photos.split(',').length : 0 })),
      generateMs: deck.durationMs,
      renderMs: rendered.durationMs,
      slideCount: inspection.slideCount,
      expectedSlides: expected,
      media: inspection.media,
      leaks,
      slides: rendered.slides.map((s) => ({ ...s, text: inspection.slides[s.index - 1]?.joined || '' })),
      renderError,
      pptx: `${variant}.pptx`,
    });
  }

  return decks;
}

(async () => {
  const tools = await checkTools();
  if (!tools.ok) {
    console.error('\nCannot rasterise decks — a conversion tool is missing:');
    for (const name of ['libreoffice', 'pdftoppm']) {
      if (!tools[name].available) console.error(`  ${name}: ${tools[name].error}`);
    }
    console.error(`\n${tools.hint}\n`);
    process.exit(1);
  }

  const dir = options.outDir || fs.mkdtempSync(path.join(require('os').tmpdir(), 'ppt-preview-'));
  fs.mkdirSync(dir, { recursive: true });

  console.log(`\nppt-preview — ${wanted.join(', ')}`);
  console.log(`  source: ${options.useDb ? 'database (Prisma)' : `${options.count} fixture warehouses`}`);
  console.log(`  network: ${options.offline ? 'blocked except the fixture photo origin' : 'open'}`);
  console.log(`  output: ${dir}\n`);

  let session = await createSession({
    count: options.count,
    offline: options.offline,
    useDb: options.useDb,
  });
  let decks = await buildAll(session, dir);

  if (options.offline && session.guard.attempts.length) {
    console.log('\n  blocked outbound calls:');
    for (const { host, count } of session.guard.summary()) console.log(`    ${host} ×${count}`);
  }

  const state = () => ({
    decks,
    dir,
    meta: {
      source: options.useDb ? 'database' : `${options.count} fixtures`,
      offline: options.offline,
      dpi: options.dpi,
      ids: options.ids,
      blocked: options.offline ? session.guard.summary() : [],
      photoRequests: session.images.requests.length,
      customDetails: options.customDetails,
      generatedAt: new Date().toISOString(),
    },
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${options.port}`);

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderContactSheet(state()));
      return;
    }

    if (url.pathname === '/rebuild') {
      console.log('\n→ rebuild requested; reloading slide code');
      try {
        const cleared = clearDeckModuleCache();
        console.log(`  dropped ${cleared} cached module(s)`);
        await session.close();
        // Re-require through the freshly cleared cache.
        const { createSession: freshCreateSession } = require('./lib/generate');
        session = await freshCreateSession({
          count: options.count, offline: options.offline, useDb: options.useDb,
        });
        decks = await buildAll(session, dir);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        console.error(`  rebuild failed: ${error.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
      return;
    }

    const file = path.join(dir, path.basename(decodeURIComponent(url.pathname)));
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const type = file.endsWith('.png') ? 'image/png'
        : file.endsWith('.pdf') ? 'application/pdf'
          : file.endsWith('.pptx') ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
            : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  server.listen(options.port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${options.port}`;
    console.log(`\n  Preview: ${url}`);
    console.log('  Edit anything under src/ppt/ and press Rebuild on the page.');
    console.log('  Ctrl-C to stop.\n');
    if (options.open) execFile('xdg-open', [url], () => {});
  });

  const shutdown = async () => {
    server.close();
    await session.close();
    if (!options.outDir) {
      console.log(`\n  artefacts left in ${dir}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
