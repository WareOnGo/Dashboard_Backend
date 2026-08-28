#!/usr/bin/env node
/**
 * Automated checks over every deck variant.
 *
 *   node tools/ppt-preview/eval.js              # all variants
 *   node tools/ppt-preview/eval.js v2 tci       # just these
 *   node tools/ppt-preview/eval.js --no-render  # skip LibreOffice; XML checks only
 *
 * Two layers, for two different costs:
 *
 *   - reading the .pptx zip (milliseconds, no system tools): slide count, every
 *     line of text, every embedded image and its dimensions. This is where the
 *     assertions that matter live — a vanished slide, an "undefined" on a
 *     customer-facing deck, a photo that never got embedded, a phone photo whose
 *     rotation was not baked in.
 *   - rasterising through LibreOffice (seconds): catches what only pixels can,
 *     namely a slide that renders blank.
 *
 * Exits non-zero when a check fails, so it can gate a change to slide code.
 * Writes out/eval/report.html — the same contact sheet the preview serves, with
 * the check results above it.
 */
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { VARIANTS, VARIANT_NAMES, paths } = require('./config');
const { createSession } = require('./lib/generate');
const { renderToPngs, checkTools } = require('./lib/render');
const { inspect, findLeaks } = require('./lib/pptx');
const { renderContactSheet } = require('./lib/page');

const argv = process.argv.slice(2);
const named = argv.filter((a) => !a.startsWith('--'));
const skipRender = argv.includes('--no-render');
const variants = named.length ? named : VARIANT_NAMES;

for (const variant of variants) {
  if (!VARIANTS[variant]) {
    console.error(`Unknown variant "${variant}". Known: ${VARIANT_NAMES.join(', ')}`);
    process.exit(1);
  }
}

const results = [];
let currentGroup = '';

/**
 * Record one check.
 *
 * `knownIssue` marks a check that documents a defect currently in the product:
 * it does not fail the run while the defect stands, and it does fail once the
 * behaviour is fixed, prompting whoever fixed it to drop the annotation and keep
 * the check as a regression guard. Same bargain as a skip-with-a-reason, except
 * it cannot rot silently.
 */
function check(name, condition, detail = '', { knownIssue = null } = {}) {
  const pass = !!condition;

  if (knownIssue) {
    if (pass) {
      results.push({
        name: `${currentGroup}${name}`,
        pass: false,
        detail: `this known issue appears to be FIXED — remove the knownIssue annotation and keep the check (${knownIssue})`,
      });
      console.log(`  ! ${name} — known issue appears FIXED; remove the annotation`);
      return true;
    }
    results.push({ name: `${currentGroup}${name}`, pass: true, known: true, detail: `known issue: ${knownIssue}` });
    console.log(`  ~ ${name} — known issue (see report)`);
    return false;
  }

  results.push({ name: `${currentGroup}${name}`, pass, detail });
  console.log(`${pass ? '  ✓' : '  ✕'} ${name}${!pass && detail ? ` — ${detail}` : ''}`);
  return pass;
}

function skip(name, reason) {
  results.push({ name: `${currentGroup}${name}`, pass: false, skipped: true, detail: reason });
  console.log(`  – ${name} — ${reason}`);
}

(async () => {
  const tools = skipRender ? { ok: false, hint: 'skipped with --no-render' } : await checkTools();
  const willRender = tools.ok;

  if (!willRender && !skipRender) {
    console.log('\nLibreOffice or pdftoppm is unavailable — running the XML checks only.');
    console.log(`${tools.hint}\n`);
  }

  const outDir = path.join(paths.out, 'eval');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const session = await createSession({ count: 6, offline: true });
  const decks = [];

  console.log(`\nppt-preview eval — ${variants.join(', ')}`);
  console.log(`  6 fixture warehouses · network blocked · rasterise ${willRender ? 'yes' : 'no'}\n`);

  // ── Per-variant checks ────────────────────────────────────────────────────
  for (const variant of variants) {
    const spec = VARIANTS[variant];
    currentGroup = `${variant}: `;
    console.log(`${variant} (${spec.label})`);

    const guardBefore = session.guard.attempts.length;
    let deck;
    try {
      deck = await session.build(variant);
    } catch (error) {
      check('generates a deck', false, error.message);
      decks.push({ variant, label: spec.label, error: error.message, slides: [] });
      console.log('');
      continue;
    }
    check('generates a deck', deck.buffer.length > 0, `${deck.buffer.length} bytes`);

    const inspection = await inspect(deck.buffer);
    const expected = spec.slides(deck.warehouses);
    check(
      `has ${expected} slides for ${deck.warehouses.length} warehouses`,
      inspection.slideCount === expected,
      `got ${inspection.slideCount}`,
    );

    const leaks = findLeaks(inspection);
    check(
      'no placeholder values on any slide',
      leaks.length === 0,
      leaks.map((l) => `slide ${l.slide}: ${l.leak} in "${l.text}"`).join('; '),
    );

    // Every warehouse with photos should have contributed at least one image.
    const withPhotos = deck.warehouses.filter((w) => w.photos && w.photos.trim()).length;
    const images = inspection.media.filter((m) => m.width);
    check(
      'embeds the supplied photographs',
      images.length >= withPhotos,
      `${images.length} embedded image(s) for ${withPhotos} warehouse(s) with photos`,
    );

    // A variant that reaches the network when it should not is worth knowing about.
    const reached = session.guard.attempts.slice(guardBefore);
    const hosts = [...new Set(reached.map((a) => a.host))];
    if (spec.network) {
      // Every enrichment call was refused, so this asserts the documented
      // fallback: a deck of the same shape, minus the enriched fields.
      check(
        'survives enrichment being unreachable',
        inspection.slideCount === expected && leaks.length === 0,
        `${inspection.slideCount} slides, ${leaks.length} leak(s) after ${reached.length} refused call(s)`,
      );
      console.log(`    reached ${hosts.join(', ') || 'nothing'} — ${reached.length} call(s), all refused`);
    } else {
      check('makes no outbound calls', reached.length === 0, `reached ${hosts.join(', ')}`);
    }

    let rendered = { slides: [], durationMs: 0 };
    let renderError = null;
    if (willRender) {
      try {
        rendered = await renderToPngs(deck.buffer, { outDir, name: variant });
        check(
          'rasterises every slide',
          rendered.slides.length === inspection.slideCount,
          `${rendered.slides.length} PNG(s) for ${inspection.slideCount} slide(s)`,
        );
        const blank = rendered.slides.filter((s) => s.blank);
        check(
          'no slide renders blank',
          blank.length === 0,
          blank.map((s) => `slide ${s.index} (stdev ${s.stdev})`).join(', '),
        );
      } catch (error) {
        renderError = error.message;
        check('rasterises every slide', false, error.message);
      }
    } else {
      skip('rasterises every slide', 'rasterisation disabled');
      skip('no slide renders blank', 'rasterisation disabled');
    }

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
    console.log('');
  }

  // ── Cross-cutting checks, on the variant that has all the features ────────
  currentGroup = 'v2: ';
  console.log('v2 display flags and photo handling');

  const rate = session.fixtures[0].ratePerSqft;

  /**
   * Slides where the rent is printed, found by matching a whole text run rather
   * than a substring.
   *
   * A table cell is its own run in the XML, so an exact match cannot be fooled by
   * a rate that happens to appear inside an unrelated figure (an area of 155,000
   * contains "55"). The property slide prints the bare value and the index slide
   * suffixes it, so both spellings count.
   */
  const slidesShowingRent = (inspection) => inspection.slides
    .filter((sl) => sl.text.some((run) => run.trim() === String(rate) || run.trim() === `${rate}/-`))
    .map((sl) => sl.index);

  const open = await session.build('v2', { ids: [session.fixtures[0].id] });
  const openInspection = await inspect(open.buffer);
  const openText = openInspection.text;
  const rentSlides = slidesShowingRent(openInspection);

  // The control for the two checks below. Without it, a redaction check could
  // pass simply because the matcher never finds the rate anywhere — the deck is
  // supposed to print it twice, on the index slide and on the property slide.
  check(
    'prints the rent on two slides when commercials are on',
    rentSlides.length === 2,
    `rate ${rate} found on slide(s) ${rentSlides.join(', ') || 'none'} — expected the index and property slides`,
  );

  const redacted = await session.build('v2', {
    ids: [session.fixtures[0].id],
    customDetails: { commercials: false },
  });
  const redactedInspection = await inspect(redacted.buffer);
  const propertySlide = redactedInspection.slides.find((sl) => /Option 1/.test(sl.joined));
  const indexSlide = redactedInspection.slides.find((sl) => /Quoted Monthly Rental/.test(sl.joined));
  const onDemand = (slide) => /available on demand/i.test(slide?.joined || '');

  check(
    '--no-commercials withholds the rent on the property slide',
    !propertySlide?.text.some((run) => run.trim() === String(rate)) && onDemand(propertySlide),
    'the rate is still on the property slide, or the placeholder text is missing',
  );

  // Regression guard. The index slide used to keep the whole rate table: the
  // flags were never passed to generateIndexSlideV2, so a deck built with
  // commercials off redacted each property slide and then printed every rate on
  // the page right after the title.
  check(
    '--no-commercials withholds the rent on the index slide',
    !indexSlide?.text.some((run) => run.trim() === `${rate}/-`) && onDemand(indexSlide),
    `the index slide still lists "${rate}/-" under Quoted Monthly Rental`,
  );

  // The invariant the user is actually relying on when they untick the box: the
  // number appears nowhere in the deck, whichever slide might carry it.
  const leakedOn = slidesShowingRent(redactedInspection);
  check(
    '--no-commercials leaves the rent on no slide at all',
    leakedOn.length === 0,
    `rate ${rate} still appears on slide(s) ${leakedOn.join(', ')}`,
  );

  const noMaps = await session.build('v2', {
    ids: [session.fixtures[0].id],
    customDetails: { mapsLocation: false },
  });
  const noMapsText = (await inspect(noMaps.buffer)).text;
  check(
    '--no-maps withholds the coordinates',
    !noMapsText.includes('19.2969'),
    'coordinates are still on the slide',
  );

  const withPoc = await inspect((await session.build('v2', { ids: [session.fixtures[0].id] })).buffer);
  const withoutPoc = await inspect((await session.build('v2', {
    ids: [session.fixtures[0].id],
    customDetails: { pocSlide: false },
  })).buffer);
  check(
    '--no-poc drops exactly one slide',
    withoutPoc.slideCount === withPoc.slideCount - 1,
    `${withPoc.slideCount} with, ${withoutPoc.slideCount} without`,
  );

  // The EXIF case: fixture 1002's first photo is a landscape JPEG tagged
  // Orientation 6. PowerPoint and LibreOffice both ignore that tag, so the
  // builder has to bake the rotation into the pixels — otherwise the photo lands
  // on the slide sideways. Visible from outside as a portrait image with no tag.
  const rotatedDeck = await session.build('v2', { ids: [1002] });
  const rotatedMedia = (await inspect(rotatedDeck.buffer)).media.filter((m) => m.width);
  const portrait = rotatedMedia.filter((m) => m.height > m.width);
  check(
    'bakes EXIF rotation into a phone photo',
    portrait.length === 1 && !portrait[0].orientation,
    `${portrait.length} portrait image(s); dimensions ${rotatedMedia.map((m) => `${m.width}x${m.height}`).join(', ')}`,
  );

  // Fixture 1005's second photo answers 404. A deck missing one photo is a
  // degraded deck, not a failed one.
  const missingPhoto = await session.build('v2', { ids: [1005] });
  const missingInspection = await inspect(missingPhoto.buffer);
  check(
    'survives a photo URL that 404s',
    missingInspection.slideCount === VARIANTS.v2.slides(missingPhoto.warehouses),
    `${missingInspection.slideCount} slides`,
  );

  // Same inputs, same slides — otherwise nothing above can be trusted twice.
  const twice = await inspect((await session.build('v2', { ids: [session.fixtures[0].id] })).buffer);
  check('produces the same text on a rebuild', twice.text === openText, 'deck text changed between builds');

  console.log('');

  // ── Report ───────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.pass && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  const known = results.filter((r) => r.known);
  const passed = results.length - failed.length - skipped.length - known.length;

  const meta = {
    source: '6 fixtures',
    offline: true,
    dpi: require('./config').render.dpi,
    ids: null,
    blocked: session.guard.summary(),
    photoRequests: session.images.requests.length,
    customDetails: { commercials: true, mapsLocation: true, pocSlide: true },
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(
    path.join(outDir, 'report.html'),
    renderContactSheet({ decks, dir: outDir, meta, results }),
  );
  fs.writeFileSync(
    path.join(outDir, 'summary.json'),
    `${JSON.stringify({
      passed, failed: failed.length, known: known.length, skipped: skipped.length,
      results, blocked: meta.blocked,
    }, null, 2)}\n`,
  );

  console.log(
    `${passed} passed · ${failed.length} failed`
    + `${known.length ? ` · ${known.length} known issue(s)` : ''}`
    + `${skipped.length ? ` · ${skipped.length} skipped` : ''}`,
  );
  for (const entry of known) console.log(`  ~ ${entry.name}`);
  if (meta.blocked.length) {
    console.log(`blocked outbound: ${meta.blocked.map((b) => `${b.host} ×${b.count}`).join(', ')}`);
  }
  console.log(`report → ${path.join(outDir, 'report.html')}\n`);

  await session.close();
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
