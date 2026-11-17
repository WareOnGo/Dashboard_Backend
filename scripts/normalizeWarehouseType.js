/**
 * Collapse legacy `Warehouse.warehouseType` values onto the four canonical types
 * (PEB / RCC / BTS / Shed).
 *
 * WHY. The column is a free-text String and the API validator only ever asked for
 * `min(1)`, so every spelling a human typed before the form became a dropdown is
 * still in the table — 38 distinct values over 2,456 rows. The damage is not
 * cosmetic: the dashboard's type filter merges the DB's distinct values into its
 * dropdown (useWarehouseFilterOptions.js), the stats endpoint groups by the raw
 * column, and the RCC-only fields in WarehouseForm / WarehouseDetailsModal are
 * gated on `warehouseType === 'RCC'` exactly — so a row typed 'Rcc' silently
 * loses its floors / lift / per-floor-area fields.
 *
 * Mapping is an explicit table, not a fuzzy matcher. Each entry below was read
 * against its rows before being written down; anything not in the table is left
 * alone and reported, so a value that appears later fails loudly rather than
 * being guessed at.
 *
 * DEFAULT IS --dry-run: prints the exact per-value plan and touches nothing.
 *
 * Usage:
 *   node -r dotenv/config scripts/normalizeWarehouseType.js
 *   node -r dotenv/config scripts/normalizeWarehouseType.js --tier=1,2
 *   node -r dotenv/config scripts/normalizeWarehouseType.js --tier=1,2 --apply
 */
const { PrismaClient } = require('@prisma/client');

const CANONICAL = ['PEB', 'RCC', 'BTS', 'Shed'];

const arg = (n, d) => {
    const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.split('=').slice(1).join('=') : d;
};
const APPLY = process.argv.includes('--apply');
const TIERS = new Set(String(arg('tier', '1,2')).split(',').map((t) => t.trim()));

/**
 * tier 1 — case/whitespace only. The intent is unambiguous; no judgement applied.
 * tier 2 — typos and qualifier words around a type that is still unmistakable.
 * tier 3 — rows naming two structures. We keep the dominant/primary structure and
 *          preserve the original string in scoutNotes so nothing is lost.
 * tier 4 — values that are not a structure type at all. No safe automatic target;
 *          listed for a human decision rather than mapped.
 */
const MAP = [
    // tier 1 — 66 rows
    { from: 'Rcc', to: 'RCC', tier: '1' },
    { from: 'rcc', to: 'RCC', tier: '1' },
    { from: 'SHED', to: 'Shed', tier: '1' },
    { from: 'shed', to: 'Shed', tier: '1' },
    { from: 'peb', to: 'PEB', tier: '1' },

    // tier 2 — 20 rows
    { from: 'PBE', to: 'PEB', tier: '2' },                      // transposition
    { from: 'PEM', to: 'PEB', tier: '2' },                      // adjacent-key typo
    { from: 'Industrial PEB', to: 'PEB', tier: '2' },
    { from: 'RCC Office', to: 'RCC', tier: '2' },
    { from: 'RCC Building', to: 'RCC', tier: '2' },
    { from: 'Industrial Shed', to: 'Shed', tier: '2' },
    { from: 'Dome shed', to: 'Shed', tier: '2' },
    { from: 'Shed B type', to: 'Shed', tier: '2' },
    { from: 'BTD', to: 'BTS', tier: '2' },                      // adjacent-key typo
    { from: 'Build suit', to: 'BTS', tier: '2' },
    { from: 'Build suite', to: 'BTS', tier: '2' },
    { from: 'Built to Suite', to: 'BTS', tier: '2' },
    { from: 'Empty land Build to suit', to: 'BTS', tier: '2' },

    // tier 3 and 4 are id-keyed below — the same string maps to different types
    // depending on the building (see ROW_MAP), so a value-keyed rule cannot express them.
];

/**
 * tier 3 — rows naming two structures. Target chosen from clear height, not from
 * which type was typed first: PEB spans run 28-40ft, sheds 15-25ft, RCC godowns
 * 10-16ft per floor. Name order disagrees with the building on 4 of these 11.
 * The original string is appended to scoutNotes so the reading stays auditable.
 */
const ROW_MAP = [
    { id: 1734, from: 'PEB/RCC', to: 'RCC', why: 'ht 10ft / centre 12ft — too low for PEB' },
    { id: 288, from: 'peb/rcc', to: 'RCC', why: 'ht 12ft, 0 docks' },
    { id: 1693, from: 'Rcc Cum Shed', to: 'Shed', why: 'centre 30ft is the main span; RCC is the 1,000sft office' },
    { id: 1699, from: 'Rcc cum Shed', to: 'Shed', why: 'centre 32ft main span, RCC office portion only' },
    { id: 495, from: 'PEB/RCC', to: 'PEB', why: 'ht 30ft' },
    { id: 1096, from: 'PEB - Big box, RCC - 11,500 sft', to: 'PEB', why: 'ht 30ft, 6 docks, big box is the primary' },
    { id: 1283, from: 'PEB Industrial Shed', to: 'PEB', why: 'ht 40ft' },
    { id: 1737, from: 'RCC,PEB', to: 'RCC', why: 'centre 14ft' },
    { id: 1504, from: 'Rcc,shed', to: 'RCC', why: 'ht 15ft, three stacked areas, goods lift' },
    { id: 477, from: 'RCC/Shed', to: 'RCC', why: 'basement with conveyors' },
    { id: 503, from: 'RCC/Shed', to: 'RCC', why: 'ground 2,000sft + first floor 1,500sft' },
];

/**
 * tier 4 — values that named a use-case or a land parcel rather than a structure.
 * The five Hyderabad "dry" rows are ordinary PEB warehouses (22-30ft, 2-4 docks,
 * photographed); the cargo sense moves to suitableFor, which is already the
 * free-form array for exactly this. The three land parcels become BTS.
 */
const USE_CASE_MAP = [
    { id: 1204, from: 'Dry Storage', to: 'PEB', suitableFor: 'Dry Storage' },
    { id: 1205, from: 'Dry Storage', to: 'PEB', suitableFor: 'Dry Storage' },
    { id: 1206, from: 'Dry Storage', to: 'PEB', suitableFor: 'Dry Storage' },
    { id: 1208, from: 'Dry Storage', to: 'PEB', suitableFor: 'Dry Storage' },
    { id: 1207, from: 'Dry Warehouse', to: 'PEB', suitableFor: 'Dry Storage' },
    { id: 689, from: 'Open land', to: 'BTS' },
    { id: 691, from: 'Open Land', to: 'BTS' },
    { id: 692, from: 'Open Land', to: 'BTS' },
];

/** Values deliberately left for a human: not a structure type, no safe target. */
const NEEDS_DECISION = ['', 'Commercial Shop', 'General'];

function scriptClient() {
    const url = process.env.DATABASE_URL || '';
    const withLimit = /connection_limit=\d+/.test(url)
        ? url.replace(/connection_limit=\d+/, 'connection_limit=1')
        : url + (url.includes('?') ? '&' : '?') + 'connection_limit=1';
    return new PrismaClient({ datasources: { db: { url: withLimit } } });
}

/** Append a stamp to scoutNotes without losing what a scout already wrote. */
function stamped(existing, from, why) {
    const stamp = `[type-normalisation] original warehouseType: ${from}`
        + (why ? ` (reclassified: ${why})` : '');
    return existing?.trim() ? `${existing.trim()}\n${stamp}` : stamp;
}

/**
 * Apply an id-keyed table. Each row is written only if it still holds the value
 * the mapping was decided against, so a second run is a no-op and a row someone
 * edited in the meantime is skipped and reported rather than overwritten.
 */
async function applyRowMap(prisma, table, label, apply) {
    const ids = table.map((m) => m.id);
    const live = await prisma.warehouse.findMany({
        where: { id: { in: ids } },
        select: { id: true, warehouseType: true, scoutNotes: true, suitableFor: true },
    });
    const byId = new Map(live.map((r) => [r.id, r]));

    let planned = 0; let written = 0; const skipped = [];
    for (const m of table) {
        const row = byId.get(m.id);
        if (!row) { skipped.push(`${m.id}: row not found`); continue; }
        if (row.warehouseType !== m.from) {
            if (row.warehouseType === m.to) continue; // already applied
            skipped.push(`${m.id}: holds ${JSON.stringify(row.warehouseType)}, expected ${JSON.stringify(m.from)}`);
            continue;
        }
        planned++;
        const extra = m.suitableFor ? `  +suitableFor[${m.suitableFor}]` : '';
        console.log(`  ${label}  ${String(m.id).padStart(5)}  ${JSON.stringify(m.from).padEnd(34)} -> ${m.to}${extra}`);
        if (m.why) console.log(`           ${m.why}`);
        if (!apply) continue;

        const data = {
            warehouseType: m.to,
            scoutNotes: stamped(row.scoutNotes, m.from, m.why),
        };
        if (m.suitableFor && !row.suitableFor.includes(m.suitableFor)) {
            data.suitableFor = [...row.suitableFor, m.suitableFor];
        }
        await prisma.warehouse.update({ where: { id: m.id }, data });
        written++;
    }
    if (skipped.length) {
        console.log(`  ${label} skipped:`);
        for (const s of skipped) console.log(`    ${s}`);
    }
    return { planned, written };
}

async function main() {
    const prisma = scriptClient();
    const selected = MAP.filter((m) => TIERS.has(m.tier));

    const counts = await prisma.warehouse.groupBy({
        by: ['warehouseType'],
        _count: { _all: true },
    });
    const byValue = new Map(counts.map((c) => [c.warehouseType, c._count._all]));

    console.log(`mode: ${APPLY ? 'APPLY' : 'dry-run'}   tiers: ${[...TIERS].join(',')}`);
    console.log(`table: ${counts.length} distinct values, ${[...byValue.values()].reduce((a, b) => a + b, 0)} rows\n`);

    let planned = 0;
    for (const m of selected) {
        const n = byValue.get(m.from) || 0;
        if (!n) continue;
        planned += n;
        console.log(`  tier ${m.tier}  ${String(n).padStart(4)}  ${JSON.stringify(m.from)} -> ${m.to}`);
    }

    if (APPLY) {
        for (const m of selected) {
            if (!byValue.get(m.from)) continue;
            const res = await prisma.warehouse.updateMany({
                where: { warehouseType: m.from }, data: { warehouseType: m.to },
            });
            planned += 0; console.log(`  wrote ${JSON.stringify(m.from)} -> ${m.to} (${res.count})`);
        }
    }

    let written = 0;
    if (TIERS.has('3')) {
        console.log('\ntier 3 — two structures named, target read from clear height:');
        const r = await applyRowMap(prisma, ROW_MAP, 'tier 3', APPLY);
        planned += r.planned; written += r.written;
    }
    if (TIERS.has('4')) {
        console.log('\ntier 4 — use-case and land values:');
        const r = await applyRowMap(prisma, USE_CASE_MAP, 'tier 4', APPLY);
        planned += r.planned; written += r.written;
    }

    const mappedValues = new Set([
        ...MAP.map((m) => m.from),
        ...ROW_MAP.map((m) => m.from),
        ...USE_CASE_MAP.map((m) => m.from),
    ]);
    const unmapped = [...byValue.keys()].filter((v) => !CANONICAL.includes(v) && !mappedValues.has(v));
    if (unmapped.length) {
        console.log('\nleft alone (needs a human decision):');
        for (const v of unmapped) {
            const flag = NEEDS_DECISION.includes(v) ? '' : '  <-- NEW, not in the reviewed set';
            console.log(`  ${String(byValue.get(v)).padStart(4)}  ${JSON.stringify(v)}${flag}`);
        }
    }

    if (!APPLY) {
        console.log(`\nplanned: ${planned} rows`);
        console.log('dry-run: nothing written. Re-run with --apply to write.');
    } else {
        const after = await prisma.warehouse.groupBy({ by: ['warehouseType'] });
        console.log(`\nwritten: ${written} rows`);
        console.log(`distinct values now: ${after.length}`);
    }
    await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
