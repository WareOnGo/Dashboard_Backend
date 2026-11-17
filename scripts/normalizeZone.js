/**
 * Recompute `Warehouse.zone` from `Warehouse.state`.
 *
 * WHY. Zone is not independent data — `deriveZone(state)` is the single source of
 * truth, and the Scout form stopped collecting zone for exactly that reason
 * (warehouseValidator.js:60). Rows predating that still carry whatever was typed,
 * so 839 of 2,456 disagree with the derivation: 597 differ only in case or a
 * "South India" suffix, but 242 name the wrong zone outright — Karnataka rows
 * stored as EAST and NORTH, and a block of MISC that resolves to a real zone.
 * Zone is a filter and part of idx_warehouse_common_fields, so those rows are
 * missing from zone-filtered results today.
 *
 * This is a pure recomputation: no judgement, no mapping table, nothing to review.
 * The only thing that needs a human is a state that derives to MISC, which means
 * deriveZone has no case for it — those are reported and skipped, never written,
 * because writing MISC would destroy a hand-entered zone in favour of a fallback.
 *
 * DEFAULT IS --dry-run.
 *
 * Usage:
 *   node -r dotenv/config scripts/normalizeZone.js
 *   node -r dotenv/config scripts/normalizeZone.js --apply
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { deriveZone } = require('../src/utils/deriveZone');

const APPLY = process.argv.includes('--apply');
const SNAPSHOT = path.join(__dirname, '..', 'tools', `zone-snapshot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.rollback.sql`);

function scriptClient() {
    const url = process.env.DATABASE_URL || '';
    const withLimit = /connection_limit=\d+/.test(url)
        ? url.replace(/connection_limit=\d+/, 'connection_limit=1')
        : url + (url.includes('?') ? '&' : '?') + 'connection_limit=1';
    return new PrismaClient({ datasources: { db: { url: withLimit } } });
}

async function main() {
    const prisma = scriptClient();
    const rows = await prisma.warehouse.findMany({ select: { id: true, state: true, zone: true } });

    const changes = [];   // rows whose zone is wrong and whose state is mapped
    const unmapped = [];  // states deriveZone has no case for — never written
    for (const r of rows) {
        const to = deriveZone(r.state);
        if (to === 'MISC') { if (r.zone !== 'MISC') unmapped.push(r); continue; }
        if (r.zone !== to) changes.push({ ...r, to });
    }

    console.log(`mode: ${APPLY ? 'APPLY' : 'dry-run'}`);
    console.log(`scanned ${rows.length} rows, ${changes.length} need a new zone\n`);

    // What is actually changing, grouped so the shape of the edit is visible.
    const pairs = new Map();
    for (const c of changes) {
        const k = `${JSON.stringify(c.zone)} -> ${c.to}`;
        pairs.set(k, (pairs.get(k) || 0) + 1);
    }
    console.log('=== transitions ===');
    for (const [k, n] of [...pairs].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(n).padStart(4)}  ${k}`);
    }

    // A wrong zone is a different thing from a badly-cased one. Report both.
    const cosmetic = changes.filter((c) => c.zone.toUpperCase().replace(/ INDIA$/, '') === c.to).length;
    console.log(`\n  of which case/suffix only: ${cosmetic}`);
    console.log(`  genuinely wrong zone:      ${changes.length - cosmetic}`);

    if (unmapped.length) {
        console.log(`\n!! ${unmapped.length} rows have a state deriveZone does not map — SKIPPED, not written:`);
        const byState = new Map();
        for (const u of unmapped) byState.set(u.state, (byState.get(u.state) || 0) + 1);
        for (const [s, n] of byState) console.log(`  ${String(n).padStart(4)}  ${JSON.stringify(s)}`);
        console.log('  (add a case to src/utils/deriveZone.js, then re-run)');
    }

    if (!APPLY) {
        console.log('\ndry-run: nothing written. Re-run with --apply to write.');
        await prisma.$disconnect();
        return;
    }

    const q = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
    if (fs.existsSync(SNAPSHOT)) {
        console.error(`refusing to overwrite an existing rollback file: ${SNAPSHOT}`);
        await prisma.$disconnect();
        process.exit(1);
    }
    fs.writeFileSync(SNAPSHOT, changes.map((c) => `UPDATE "Warehouse" SET "zone"=${q(c.zone)} WHERE "id"=${c.id};`).join('\n') + '\n');
    console.log(`\nrollback SQL -> ${SNAPSHOT}`);

    // Grouped by target: six statements rather than 839 round trips over the pooler.
    //
    // Raw SQL rather than prisma.updateMany on purpose. `status_updated_at` is
    // @updatedAt, which Prisma applies client-side, so a Prisma write would stamp
    // all 839 rows with today's date — and that column is surfaced to users as
    // "Status Updated At" (WarehouseDetailsModal.jsx:664). Correcting a derived
    // zone is not a status change and should not look like one. Values are bound
    // parameters, not interpolated.
    let written = 0;
    const byTarget = new Map();
    for (const c of changes) {
        if (!byTarget.has(c.to)) byTarget.set(c.to, []);
        byTarget.get(c.to).push(c.id);
    }
    for (const [zone, ids] of byTarget) {
        const n = await prisma.$executeRawUnsafe(
            'UPDATE "Warehouse" SET "zone" = $1 WHERE "id" = ANY($2::int[])', zone, ids,
        );
        written += n;
        console.log(`  ${zone.padEnd(8)} ${n}`);
    }

    const after = await prisma.warehouse.groupBy({ by: ['zone'], _count: { _all: true } });
    console.log(`\nwritten: ${written} rows`);
    console.log('final zones:');
    for (const a of after.sort((x, y) => y._count._all - x._count._all)) {
        console.log(`  ${String(a._count._all).padStart(5)}  ${a.zone}`);
    }
    await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
