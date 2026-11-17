/**
 * Collapse spelling variants in the low-traffic spec columns.
 *
 * SCOPE IS NARROW BY DESIGN. Every entry below is a suffix, case or whitespace
 * variant of a value the column already uses. Nothing here is an inference about
 * what someone meant. In particular these are NOT mapped, because each would be a
 * guess dressed up as a cleanup:
 *
 *   flooringType     VDG, VDM, DDF, FEM, FM@  - plausibly typos for VDF/FM2, but the
 *                                               keys are not adjacent and a single
 *                                               row is not worth inventing a value
 *                    VDF/FM2 Both, RCC trimix, FM2 M30, VDF with densification,
 *                    Heavy-Duty Trimix, "Granite flooring & PCC Flooring"
 *                                             - combinations and grades; collapsing
 *                                               them would discard the distinction
 *                    Kota Stone, Marble Tiling, CC, PCC, APCR, "As per requirement"
 *                                             - distinct materials, or non-answers
 *   ventilationType  Windows, Window Ventilation, "Windows, Air Vents", Lux Level,
 *                    "Ridge, turbo", "Side Louvers & Windows"
 *                                             - single rows with no established
 *                                               canonical form to join
 *   insulationType   Roof bubble, Puff Sheet, 8mm thickness, Full furnished
 *                                             - descriptions, not categories
 *   postalCode       NA, "Google Location: NA", 5601505 (7 digits), 11004 and
 *                    56109 (5 digits)         - malformed, need a human
 *
 * DEFAULT IS --dry-run.
 *
 *   node -r dotenv/config scripts/normalizeSpecEnums.js
 *   node -r dotenv/config scripts/normalizeSpecEnums.js --apply
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');
const SNAPSHOT = path.join(__dirname, '..', 'tools',
    `specenums-snapshot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.rollback.sql`);

/** column -> { exact variant seen in production : canonical value } */
const MAPS = {
    availability: {
        'yes': 'Yes',
    },
    flooringType: {
        'VDF Flooring': 'VDF',
        'FM2 Flooring': 'FM2',
        'FM2`': 'FM2',
        'FM 2': 'FM2',
        'RCC Flooring': 'RCC',
        'Tiles Flooring': 'Tiles',
        'Tile Flooring': 'Tiles',
        'Normal Tile Flooring': 'Tiles',
        'Tiled': 'Tiles',
        'Tiling': 'Tiles',
        'Concrete Flooring': 'Concrete',
        'Concrete flooring': 'Concrete',
        'Normal Concrete Flooring': 'Concrete',
        'Normal Concrete  Flooring': 'Concrete',
        'Granite Flooring': 'Granite',
        'RMC Flooring': 'RMC',
        'Carpet Flooring': 'Carpet',
    },
    ventilationType: {
        'Turbo Ventilation': 'Turbo',
        'Turbo  vents': 'Turbo',
        'Turbo Vents': 'Turbo',
        'Ridge Ventilation': 'Ridge',
        'Ridge Ventilation.': 'Ridge',
        'Ridge+Side louvers': 'Ridge + Side Louvers',
        'Ridge+Side Louvers': 'Ridge + Side Louvers',
        'Ridge + Side louvers': 'Ridge + Side Louvers',
        'Ridge + side louvers': 'Ridge + Side Louvers',
        'Ridge, Side Louvers': 'Ridge + Side Louvers',
        'N/A': 'None',
    },
    insulationType: {
        'N/A': 'None',
        'NA': 'None',
        'Not Available': 'None',
        'Thermal insulation': 'Thermal Insulation',
    },
    // Handled by rule rather than table: strip a trailing dot and internal spaces,
    // and accept the result only if it is a valid 6-digit Indian PIN.
    postalCode: null,
};

function canonicalPin(raw) {
    const v = String(raw).trim().replace(/\.$/, '').replace(/\s+/g, '');
    return /^[0-9]{6}$/.test(v) ? v : null;
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
    const cols = Object.keys(MAPS);
    const select = Object.fromEntries([['id', true], ...cols.map((c) => [c, true])]);
    const rows = await prisma.warehouse.findMany({ select });

    const changes = [];
    const untouched = {};
    for (const col of cols) {
        const map = MAPS[col];
        untouched[col] = new Map();
        for (const r of rows) {
            const v = r[col];
            if (v === null || String(v).trim() === '') continue;
            let to = null;
            if (col === 'postalCode') {
                const pin = canonicalPin(v);
                if (pin && pin !== v) to = pin;
                else if (!pin) untouched[col].set(v, (untouched[col].get(v) || 0) + 1);
            } else if (Object.prototype.hasOwnProperty.call(map, v)) {
                to = map[v];
            }
            if (to && to !== v) changes.push({ col, id: r.id, from: v, to });
        }
    }

    console.log(`mode: ${APPLY ? 'APPLY' : 'dry-run'}   ${rows.length} rows scanned\n`);
    for (const col of cols) {
        const mine = changes.filter((c) => c.col === col);
        console.log(`=== ${col}: ${mine.length} rows ===`);
        const pairs = new Map();
        for (const c of mine) {
            const k = `${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`;
            pairs.set(k, (pairs.get(k) || 0) + 1);
        }
        for (const [k, n] of [...pairs].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
        if (untouched[col].size) {
            console.log('  left alone (malformed, needs a human):');
            for (const [v, n] of untouched[col]) console.log(`    ${String(n).padStart(3)}  ${JSON.stringify(v)}`);
        }
        console.log();
    }
    console.log(`total: ${changes.length} rows`);

    if (!APPLY) {
        console.log('\ndry-run: nothing written. Re-run with --apply to write.');
        await prisma.$disconnect();
        return;
    }
    if (fs.existsSync(SNAPSHOT)) {
        console.error(`refusing to overwrite an existing rollback file: ${SNAPSHOT}`);
        await prisma.$disconnect();
        process.exit(1);
    }
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    fs.writeFileSync(SNAPSHOT, changes.map((c) => `UPDATE "Warehouse" SET "${c.col}"=${q(c.from)} WHERE "id"=${c.id};`).join('\n') + '\n');
    console.log(`\nrollback SQL -> ${SNAPSHOT}`);

    // Raw SQL grouped by (column, target): `status_updated_at` is @updatedAt and is
    // shown to users as "Status Updated At"; a spelling fix is not a status change.
    let written = 0;
    const groups = new Map();
    for (const c of changes) {
        const k = `${c.col}\u0000${c.to}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(c.id);
    }
    for (const [k, ids] of groups) {
        const [col, to] = k.split('\u0000');
        written += await prisma.$executeRawUnsafe(
            `UPDATE "Warehouse" SET "${col}" = $1 WHERE "id" = ANY($2::int[])`, to, ids);
    }
    console.log(`written: ${written} rows across ${groups.size} (column, value) groups`);
    for (const col of cols) {
        const d = await prisma.$queryRawUnsafe(
            `SELECT COUNT(DISTINCT "${col}")::int AS n FROM "Warehouse" WHERE "${col}" IS NOT NULL AND "${col}" <> ''`);
        console.log(`  ${col.padEnd(16)} ${d[0].n} distinct`);
    }
    await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
