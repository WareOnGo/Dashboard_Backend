/**
 * Collapse spelling variants of `Warehouse.warehouseOwnerType` onto the spelling
 * each family already uses in the majority of rows.
 *
 * SCOPE: case and typo only. This script deliberately does NOT decide what the
 * column means.
 *
 * The column holds two eras of data. The form today offers three options
 * (WarehouseForm.jsx:32 — Individual / Company / 3PL), but 735 rows say 'Owner' or
 * 'Broker', which answer the older question "is your contact the owner or a
 * broker?" — the question `isBroker` asks now. That overlap is why the two columns
 * contradict each other on 532 rows. Resolving it is a product decision: nothing in
 * the data can split 'Owner' into Individual vs Company, because `ownerCompanyName`
 * is empty on 643 of those 646 rows. So 'Owner' and 'Broker' rows are left saying
 * 'Owner' and 'Broker' here — just spelled consistently.
 *
 * Also held back, for the same no-information-loss reason: values that append a
 * company name to a valid type ('Company (FWS)', '3PL - Ashapura WareHouse') and the
 * 14 rows holding a bare company name. Those belong in `ownerCompanyName`, which is
 * a move, not a rename.
 *
 * DEFAULT IS --dry-run.
 *
 *   node -r dotenv/config scripts/normalizeOwnerType.js
 *   node -r dotenv/config scripts/normalizeOwnerType.js --apply
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');
const SNAPSHOT = path.join(__dirname, '..', 'tools', `ownertype-snapshot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.rollback.sql`);

/** Every variant seen in production, read off the table rather than guessed. */
const MAP = new Map(Object.entries({
    individual: 'Individual',
    INDIVIDUAL: 'Individual',
    inidividual: 'Individual',
    Individial: 'Individual',
    Individua: 'Individual',
    Undividual: 'Individual',
    Indivudual: 'Individual',
    company: 'Company',
    owner: 'Owner',
    Onwer: 'Owner',
    '3pl': '3PL',
    broker: 'Broker',
}));

/** Already-correct spellings. Anything outside these and MAP is reported, not written. */
const CANONICAL = new Set(['Individual', 'Company', '3PL', 'Owner', 'Broker']);

function scriptClient() {
    const url = process.env.DATABASE_URL || '';
    const withLimit = /connection_limit=\d+/.test(url)
        ? url.replace(/connection_limit=\d+/, 'connection_limit=1')
        : url + (url.includes('?') ? '&' : '?') + 'connection_limit=1';
    return new PrismaClient({ datasources: { db: { url: withLimit } } });
}

async function main() {
    const prisma = scriptClient();
    const rows = await prisma.warehouse.findMany({ select: { id: true, warehouseOwnerType: true } });

    const changes = [];
    const untouched = new Map();
    for (const r of rows) {
        const v = r.warehouseOwnerType;
        if (v === null) continue;
        const to = MAP.get(v.trim());
        if (to) { changes.push({ id: r.id, from: v, to }); continue; }
        if (!CANONICAL.has(v.trim())) untouched.set(v, (untouched.get(v) || 0) + 1);
    }

    console.log(`mode: ${APPLY ? 'APPLY' : 'dry-run'}`);
    console.log(`scanned ${rows.length} rows, ${changes.length} need rewriting\n`);

    const pairs = new Map();
    for (const c of changes) {
        const k = `${JSON.stringify(c.from)} -> ${c.to}`;
        pairs.set(k, (pairs.get(k) || 0) + 1);
    }
    console.log('=== transitions ===');
    for (const [k, n] of [...pairs].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);

    if (untouched.size) {
        console.log('\n=== left alone: a name, or a type with a name appended (tier 2) ===');
        for (const [v, n] of [...untouched].sort((a, b) => b[1] - a[1])) {
            console.log(`  ${String(n).padStart(4)}  ${JSON.stringify(v)}`);
        }
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
    fs.writeFileSync(SNAPSHOT, changes.map((c) => `UPDATE "Warehouse" SET "warehouseOwnerType"=${q(c.from)} WHERE "id"=${c.id};`).join('\n') + '\n');
    console.log(`\nrollback SQL -> ${SNAPSHOT}`);

    // Raw SQL grouped by target: `status_updated_at` is @updatedAt and surfaces to
    // users as "Status Updated At"; a spelling fix must not stamp these rows.
    const byTarget = new Map();
    for (const c of changes) {
        if (!byTarget.has(c.to)) byTarget.set(c.to, []);
        byTarget.get(c.to).push(c.id);
    }
    let written = 0;
    for (const [type, ids] of byTarget) {
        const n = await prisma.$executeRawUnsafe(
            'UPDATE "Warehouse" SET "warehouseOwnerType" = $1 WHERE "id" = ANY($2::int[])', type, ids,
        );
        written += n;
        console.log(`  ${type.padEnd(11)} ${n}`);
    }

    const after = await prisma.$queryRawUnsafe(
        `SELECT COALESCE("warehouseOwnerType",'<null>') AS v, COUNT(*)::int AS n
         FROM "Warehouse" GROUP BY 1 ORDER BY n DESC`);
    console.log(`\nwritten: ${written} rows`);
    console.log(`distinct values now: ${after.length}`);
    for (const a of after) console.log(`  ${String(a.n).padStart(5)}  ${a.v}`);
    await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
