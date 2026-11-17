/**
 * Collapse `Warehouse.isBroker` onto 'Yes' / 'No' / null.
 *
 * WHY. The column is `String?` and the validator only asks for `z.string()`, so it
 * accumulated ten spellings of a two-state answer. This is not cosmetic:
 *
 *  - WarehouseForm.jsx:886 renders the toggle with `values.isBroker === 'Yes'`, so
 *    the 433 rows stored 'Y' or 'y' show the switch OFF on a broker listing.
 *  - The broker filter is a `contains` match on both sides (warehouseService.js:402,
 *    useWarehouseFilters.js:141), so filtering "Yes" misses those same 433 rows.
 *  - WarehouseDetailsModal.jsx:389 prints the raw value, so users read "Y", "n",
 *    "NA", "Yas" and "Available" on screen.
 *
 * 'NA' and the single 'Available' become null: 922 rows are already null meaning
 * "not recorded", and NA says the same thing in a different alphabet. Collapsing
 * them leaves one representation of unknown rather than three.
 *
 * NOT FIXED HERE, and worth knowing: isBroker contradicts warehouseOwnerType on 532
 * rows — 502 say broker while the owner type is Owner/Individual, and 30 say not-a-
 * broker while the owner type is Broker. Only 53 rows agree. Normalising the
 * spelling does not make the field trustworthy; deciding which column is
 * authoritative is a separate call.
 *
 * DEFAULT IS --dry-run.
 *
 *   node -r dotenv/config scripts/normalizeIsBroker.js
 *   node -r dotenv/config scripts/normalizeIsBroker.js --apply
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');
const SNAPSHOT = path.join(__dirname, '..', 'tools', `isbroker-snapshot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.rollback.sql`);

/** Every spelling seen in production, read off the table rather than guessed. */
const YES = ['Y', 'y', 'Yes', 'yes', 'YES', 'Yas'];
const NO = ['N', 'n', 'No', 'no', 'NO'];
const UNKNOWN = ['NA', 'N/A', 'na', 'Available', ''];

function canonical(v) {
    if (v === null || v === undefined) return undefined;   // already unknown, skip
    if (YES.includes(v.trim())) return 'Yes';
    if (NO.includes(v.trim())) return 'No';
    if (UNKNOWN.includes(v.trim())) return null;
    return undefined;                                       // unrecognised: report, never write
}

function scriptClient() {
    const url = process.env.DATABASE_URL || '';
    const withLimit = /connection_limit=\d+/.test(url)
        ? url.replace(/connection_limit=\d+/, 'connection_limit=1')
        : url + (url.includes('?') ? '&' : '?') + 'connection_limit=1';
    return new PrismaClient({ datasources: { db: { url: withLimit } } });
}

async function main() {
    const prisma = scriptClient();
    const rows = await prisma.warehouse.findMany({ select: { id: true, isBroker: true } });

    const changes = [];
    const unrecognised = new Map();
    for (const r of rows) {
        if (r.isBroker === null) continue;
        const to = canonical(r.isBroker);
        if (to === undefined) { unrecognised.set(r.isBroker, (unrecognised.get(r.isBroker) || 0) + 1); continue; }
        if (to !== r.isBroker) changes.push({ id: r.id, from: r.isBroker, to });
    }

    console.log(`mode: ${APPLY ? 'APPLY' : 'dry-run'}`);
    console.log(`scanned ${rows.length} rows, ${changes.length} need rewriting\n`);

    const pairs = new Map();
    for (const c of changes) {
        const k = `${JSON.stringify(c.from)} -> ${c.to === null ? 'null' : JSON.stringify(c.to)}`;
        pairs.set(k, (pairs.get(k) || 0) + 1);
    }
    console.log('=== transitions ===');
    for (const [k, n] of [...pairs].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);

    if (unrecognised.size) {
        console.log('\n!! unrecognised values — SKIPPED, not written:');
        for (const [v, n] of unrecognised) console.log(`  ${String(n).padStart(4)}  ${JSON.stringify(v)}`);
    }

    if (!APPLY) {
        console.log('\ndry-run: nothing written. Re-run with --apply to write.');
        await prisma.$disconnect();
        return;
    }

    const q = (s) => (s === null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
    if (fs.existsSync(SNAPSHOT)) {
        console.error(`refusing to overwrite an existing rollback file: ${SNAPSHOT}`);
        await prisma.$disconnect();
        process.exit(1);
    }
    fs.writeFileSync(SNAPSHOT, changes.map((c) => `UPDATE "Warehouse" SET "isBroker"=${q(c.from)} WHERE "id"=${c.id};`).join('\n') + '\n');
    console.log(`\nrollback SQL -> ${SNAPSHOT}`);

    // Raw SQL, grouped by target: `status_updated_at` is @updatedAt and is shown to
    // users as "Status Updated At", so a spelling fix must not stamp these rows.
    let written = 0;
    for (const target of ['Yes', 'No', null]) {
        const ids = changes.filter((c) => c.to === target).map((c) => c.id);
        if (!ids.length) continue;
        const n = await prisma.$executeRawUnsafe(
            'UPDATE "Warehouse" SET "isBroker" = $1 WHERE "id" = ANY($2::int[])', target, ids,
        );
        written += n;
        console.log(`  ${String(target).padEnd(5)} ${n}`);
    }

    const after = await prisma.$queryRawUnsafe(
        `SELECT COALESCE("isBroker",'<null>') AS v, COUNT(*)::int AS n FROM "Warehouse" GROUP BY 1 ORDER BY n DESC`);
    console.log(`\nwritten: ${written} rows\nfinal values:`);
    for (const a of after) console.log(`  ${String(a.n).padStart(5)}  ${a.v}`);
    await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
