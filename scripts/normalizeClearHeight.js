/**
 * Rewrite `Warehouse.clearHeightFt` to a bare number of feet where the value says
 * exactly one height and says it in feet.
 *
 * WHY. The column is a String named "...Ft", but 1,315 of 1,968 filled rows carry
 * the unit inline ("30ft", "35 ft", "30Feet", "12 Ft"). Three call sites each cope
 * differently and one does not cope at all:
 *
 *   - WarehouseCard.jsx:230 renders `Clear Height: {value} ft` with no guard, so a
 *     row holding "30ft" displays as "Clear Height: 30ft ft".
 *   - propertyFields.js:97 strips a trailing /ft|feet/ before re-appending — which
 *     mangles "30 sft" into "30 s ft" and misses "10 fts" entirely.
 *   - lastMileFields.js:6 appends the unit only to bare numbers, so it is correct
 *     but leaves the inconsistency visible in exports.
 *
 * Normalising to bare feet fixes the card and lets all three simplify.
 *
 * SCOPE. A value qualifies only if it holds exactly one distinct number, carries no
 * metric unit, and lands in a plausible clear-height band. Held back and reported:
 *
 *   - metres ("8 Meter", "15M", "12.5 MTRS") — 15M is 49ft, not 15ft; converting is
 *     a unit decision, and silently reading it as feet would be wrong by 3x;
 *   - two heights in one field ("Side height -22ft ,centre height-25ft",
 *     "Basement 19 Ft,Rest of the Floors Height 12 Ft", "30ft to 40ft") — the
 *     side/centre pair belongs in clearHeightFt + centreHeight, which is a move;
 *   - non-numeric answers ("NA", "As per client requirement").
 *
 * --include-sft additionally accepts the 96 rows whose unit reads "sft" (square
 * feet on a height field). The numbers there are plausible heights, but that is an
 * inference about what someone meant, so it is opt-in rather than default.
 *
 * DEFAULT IS --dry-run.
 *
 *   node -r dotenv/config scripts/normalizeClearHeight.js
 *   node -r dotenv/config scripts/normalizeClearHeight.js --include-sft --apply
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');
const INCLUDE_SFT = process.argv.includes('--include-sft');
const COLUMN = (process.argv.find((a) => a.startsWith('--column=')) || '--column=clearHeightFt').split('=')[1];
const SNAPSHOT = path.join(__dirname, '..', 'tools', `${COLUMN.toLowerCase()}-snapshot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.rollback.sql`);

/** Anything metric. Deliberately broad: reading 15M as 15ft is wrong by over 3x.
 *  The trailing-m case catches "15M" and "3.5mM", which carry no unit word. */
const METRIC = /\d\s*m\b|\bm\b|\bmtr|\bmts|met(er|re)|\d\s*m+\.?$/i;
/** "sft" is square feet — a unit that cannot describe a height. */
const SQUARE = /s\.?\s?ft/i;

/**
 * Plausible band per column, because these are different physical quantities.
 * A clear or centre height is a roof measurement (8-55ft observed). A plinth is a
 * loading platform at truck-bed height — 0-5ft, median 4. Sharing one band would
 * reject almost every valid plinth while waving through the ones that are actually
 * a clear height typed into the wrong field.
 */
const CONFIG = {
    clearHeightFt: { min: 5, max: 100 },
    centreHeight: { min: 5, max: 100 },
    plinthHeightFt: { min: 0, max: 6, nullify: ['None'] },
};

/** @returns {{to:string|null}|{skip:string}} */
function canonicalHeight(raw, cfg) {
    const v = String(raw).trim();
    if (cfg.nullify && cfg.nullify.some((w) => w.toLowerCase() === v.toLowerCase())) return { to: null };
    if (/^[0-9]+(\.[0-9]+)?$/.test(v)) return { skip: 'already clean' };
    if (METRIC.test(v)) return { skip: 'metric unit' };
    const nums = [...new Set(v.match(/\d+(?:\.\d+)?/g) || [])];
    if (!nums.length) return { skip: 'no digits' };
    if (nums.length > 1) return { skip: 'more than one height' };
    if (SQUARE.test(v) && !INCLUDE_SFT) return { skip: 'sft (square feet) — needs --include-sft' };
    const n = parseFloat(nums[0]);
    if (!Number.isFinite(n) || n < cfg.min || n > cfg.max) {
        return { skip: `outside ${cfg.min}-${cfg.max}ft — implausible for ${COLUMN}` };
    }
    return { to: String(n) };
}

function scriptClient() {
    const url = process.env.DATABASE_URL || '';
    const withLimit = /connection_limit=\d+/.test(url)
        ? url.replace(/connection_limit=\d+/, 'connection_limit=1')
        : url + (url.includes('?') ? '&' : '?') + 'connection_limit=1';
    return new PrismaClient({ datasources: { db: { url: withLimit } } });
}

async function main() {
    const cfg = CONFIG[COLUMN];
    if (!cfg) {
        console.error(`no band configured for column ${COLUMN}; add one to CONFIG rather than borrowing another column's.`);
        process.exit(1);
    }
    const prisma = scriptClient();
    const rows = await prisma.$queryRawUnsafe(
        `SELECT "id", "${COLUMN}" AS v FROM "Warehouse" WHERE "${COLUMN}" IS NOT NULL AND "${COLUMN}" <> ''`);

    const changes = [];
    const skipped = new Map();
    for (const r of rows) {
        const res = canonicalHeight(r.v, cfg);
        if ('to' in res) { changes.push({ id: r.id, from: r.v, to: res.to }); continue; }
        if (res.skip === 'already clean') continue;
        const k = `${res.skip}`;
        if (!skipped.has(k)) skipped.set(k, []);
        skipped.get(k).push(r.v);
    }

    console.log(`column: ${COLUMN}   mode: ${APPLY ? 'APPLY' : 'dry-run'}   sft: ${INCLUDE_SFT ? 'included' : 'held back'}`);
    console.log(`${rows.length} filled rows, rewriting ${changes.length}\n`);

    const shapes = new Map();
    for (const c of changes) {
        const sh = c.to === null ? `${c.from} -> null` : c.from.replace(/\d+(?:\.\d+)?/, 'N');
        if (!shapes.has(sh)) shapes.set(sh, { n: 0, eg: `${c.from} -> ${c.to === null ? 'null' : c.to}` });
        shapes.get(sh).n++;
    }
    console.log('=== rewriting, by shape ===');
    for (const [sh, d] of [...shapes].sort((a, b) => b[1].n - a[1].n)) {
        console.log(`  ${String(d.n).padStart(4)}  ${JSON.stringify(sh).padEnd(20)} e.g. ${d.eg}`);
    }

    console.log('\n=== held back ===');
    for (const [reason, vals] of [...skipped].sort((a, b) => b[1].length - a[1].length)) {
        console.log(`  ${String(vals.length).padStart(4)}  ${reason}`);
        const uniq = [...new Set(vals)].slice(0, 6);
        console.log(`        ${uniq.map((u) => JSON.stringify(u)).join(', ')}${new Set(vals).size > 6 ? ' …' : ''}`);
    }

    if (!APPLY) {
        console.log('\ndry-run: nothing written. Re-run with --apply to write.');
        await prisma.$disconnect();
        return;
    }

    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    if (fs.existsSync(SNAPSHOT)) {
        console.error(`refusing to overwrite an existing rollback file: ${SNAPSHOT}`);
        await prisma.$disconnect();
        process.exit(1);
    }
    fs.writeFileSync(SNAPSHOT, changes.map((c) => `UPDATE "Warehouse" SET "${COLUMN}"=${q(c.from)} WHERE "id"=${c.id};`).join('\n') + '\n');
    console.log(`\nrollback SQL -> ${SNAPSHOT}`);

    const byTarget = new Map();
    for (const c of changes) {
        const k = c.to === null ? 'null' : c.to;
        if (!byTarget.has(k)) byTarget.set(k, []);
        byTarget.get(k).push(c.id);
    }
    let written = 0;
    for (const [ft, ids] of byTarget) {
        written += await prisma.$executeRawUnsafe(
            `UPDATE "Warehouse" SET "${COLUMN}" = $1 WHERE "id" = ANY($2::int[])`,
            ft === 'null' ? null : ft, ids);
    }
    console.log(`\nwritten: ${written} rows across ${byTarget.size} distinct heights`);

    const after = await prisma.$queryRawUnsafe(
        `SELECT SUM(CASE WHEN "${COLUMN}" ~ '^[0-9]+(\\.[0-9]+)?$' THEN 1 ELSE 0 END)::int AS bare,
                COUNT(*)::int AS filled FROM "Warehouse" WHERE "${COLUMN}" IS NOT NULL AND "${COLUMN}" <> ''`);
    console.log(`bare numeric: ${after[0].bare}/${after[0].filled}`);
    await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
