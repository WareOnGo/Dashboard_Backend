#!/usr/bin/env node
/**
 * Re-derive the slide counts in config.js by building real decks.
 *
 *   node tools/ppt-preview/slides.js
 *
 * Run this after an intentional layout change: the counts in VARIANTS are
 * measurements, not readings of the slide code, and the eval suite asserts them
 * exactly. Prints a table plus whether each formula still agrees.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { VARIANTS, VARIANT_NAMES } = require('./config');
const { createSession } = require('./lib/generate');
const { inspect } = require('./lib/pptx');

const COUNTS = [1, 2, 3, 4, 5, 6];

(async () => {
  const session = await createSession({ count: Math.max(...COUNTS) });
  const rows = {};
  let disagreements = 0;

  for (const variant of VARIANT_NAMES) {
    rows[variant] = {};
    for (const n of COUNTS) {
      const ids = session.defaultIds.slice(0, n);
      const { buffer, warehouses } = await session.build(variant, { ids });
      const actual = (await inspect(buffer)).slideCount;
      const predicted = VARIANTS[variant].slides(warehouses);
      rows[variant][n] = { actual, predicted };
      if (actual !== predicted) disagreements += 1;
    }
  }

  const photoCounts = session.fixtures.map((w) => (w.photos ? w.photos.split(',').length : 0));
  console.log(`\nfixture photos per warehouse: [${photoCounts.join(', ')}]`);
  console.log("(a warehouse with 0 photos changes the detailed and TCI page counts)\n");

  console.log(`${'variant'.padEnd(11)}${COUNTS.map((n) => `n=${n}`.padStart(7)).join('')}   formula`);
  for (const variant of VARIANT_NAMES) {
    const cells = COUNTS.map((n) => {
      const { actual, predicted } = rows[variant][n];
      return (actual === predicted ? String(actual) : `${actual}≠${predicted}`).padStart(7);
    }).join('');
    const agrees = COUNTS.every((n) => rows[variant][n].actual === rows[variant][n].predicted);
    console.log(`${variant.padEnd(11)}${cells}   ${agrees ? 'agrees' : 'DISAGREES — update config.js'}`);
  }

  console.log(disagreements === 0
    ? '\nconfig.js matches every measurement.\n'
    : `\n${disagreements} measurement(s) disagree with config.js — update VARIANTS.slides.\n`);

  await session.close();
  process.exit(disagreements === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
