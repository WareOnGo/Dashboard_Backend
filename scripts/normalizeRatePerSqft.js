/**
 * Rewrite `Warehouse.ratePerSqft` to a bare number where the value unambiguously
 * contains exactly one.
 *
 * WHY. The column is a String, and the app copes by stripping it at read time with
 * `regexp_replace(COALESCE(...), '[^0-9.]', '', 'g')` — warehouseModel.js:92,
 * warehouseMapFilters.js:52, and useWarehouseFilters.js:197. That strip keeps the
 * dot in "Rs.", so:
 *
 *     "Rs. 22/- per sft"  ->  ".22"  ->  0.22
 *
 * 361 rows resolve to under ₹1 and are silently excluded from every realistic
 * budget filter. The workaround has been hiding the bug rather than fixing it.
 *
 * SCOPE IS DELIBERATELY NARROW. A value qualifies only if it contains exactly one
 * distinct number, names no time unit, and lands in a plausible per-sqft band.
 * Everything else is left alone and reported:
 *
 *   - multi-floor and multi-rate pricing ("G-50, F-30, S-20", "Rs. 25/- per sft
 *     (Ground floor), Rs. 12.50/- per sft (1st Floor)") — a single column cannot
 *     hold a rate card, so collapsing these would invent a number;
 *   - monthly totals ("1 lac ( Negotiable )", "75,000 per Month") — a real figure,
 *     but not a per-sqft rate;
 *   - ranges ("80 to 110", "26 to 30") and CAM add-ons ("Rs. 24/- + Rs. 1/- (CAM)");
 *   - non-numeric answers ("Not disclosed", "TBC", "As per client requirement"),
 *     which are honest and stay as they are — the column is NOT NULL, so there is
 *     nowhere better to put them.
 *
 * Note: "Negotiable" is dropped from the ~90 values that carry it. That signal is
 * recoverable from the rollback file if it turns out to be wanted somewhere.
 *
 * DEFAULT IS --dry-run.
 *
 *   node -r dotenv/config scripts/normalizeRatePerSqft.js
 *   node -r dotenv/config scripts/normalizeRatePerSqft.js --apply
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');
const SNAPSHOT = path.join(__dirname, '..', 'tools', `rate-snapshot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.rollback.sql`);

/** Words that mean the number is a period total or a lakh/crore figure, not a rate. */
const TIME_UNIT = /month|lac|lakh|crore|\bcr\b|total|p\.?m\.?\b|annum|year/i;
/** Above this a per-sqft rate is almost certainly a monthly rent typed in the wrong box. */
const MAX_PLAUSIBLE_RATE = 500;

/** @returns {string|null} the canonical bare number, or null to leave the row alone. */
function canonicalRate(raw) {
    if (typeof raw !== 'string') return null;
    const v = raw.trim();
    if (/^[0-9]+(\.[0-9]+)?$/.test(v)) return null;          // already clean
    if (TIME_UNIT.test(v)) return null;                       // period total, not a rate
    const nums = v.match(/\d+(?:\.\d+)?/g) || [];
    if ([...new Set(nums)].length !== 1) return null;         // zero, or a rate card
    const n = parseFloat(nums[0]);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_PLAUSIBLE_RATE) return null;
    return String(n);                                         // "22.50" stays 22.5
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
    const rows = await prisma.warehouse.findMany({ select: { id: true, ratePerSqft: true } });

    const changes = [];
    const left = new Map();
    for (const r of rows) {
        const to = canonicalRate(r.ratePerSqft);
        if (to === null) {
            if (r.ratePerSqft && !/^[0-9]+(\.[0-9]+)?$/.test(r.ratePerSqft.trim())) {
                left.set(r.ratePerSqft, (left.get(r.ratePerSqft) || 0) + 1);
            }
            continue;
        }
        changes.push({ id: r.id, from: r.ratePerSqft, to });
    }

    console.log(`mode: ${APPLY ? 'APPLY' : 'dry-run'}`);
    console.log(`scanned ${rows.length} rows`);
    console.log(`  rewriting : ${changes.length}`);
    console.log(`  left alone: ${[...left.values()].reduce((a, b) => a + b, 0)} rows across ${left.size} values\n`);

    // How many of the rewritten rows were actually broken under the app's own cleaner?
    const wasBroken = changes.filter((c) => {
        const cleaned = c.from.replace(/[^0-9.]/g, '');
        return cleaned === '' || cleaned.startsWith('.') || parseFloat(cleaned) !== parseFloat(c.to);
    }).length;
    console.log(`of those, misparsed by the current regexp_replace: ${wasBroken}`);

    console.log('\n=== sample of the rewrite ===');
    const seen = new Set();
    for (const c of changes) {
        if (seen.has(c.from) || seen.size >= 16) continue;
        seen.add(c.from);
        console.log(`  ${JSON.stringify(c.from).padEnd(34)} -> ${c.to}`);
    }

    console.log('\n=== left alone, by row count ===');
    for (const [v, n] of [...left].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
        console.log(`  ${String(n).padStart(4)}  ${JSON.stringify(v)}`);
    }
    if (left.size > 18) console.log(`  … and ${left.size - 18} more values`);

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
    fs.writeFileSync(SNAPSHOT, changes.map((c) => `UPDATE "Warehouse" SET "ratePerSqft"=${q(c.from)} WHERE "id"=${c.id};`).join('\n') + '\n');
    console.log(`\nrollback SQL -> ${SNAPSHOT}`);

    // Grouped by target value, raw SQL so `status_updated_at` (@updatedAt, shown to
    // users as "Status Updated At") is not stamped by a formatting correction.
    const byTarget = new Map();
    for (const c of changes) {
        if (!byTarget.has(c.to)) byTarget.set(c.to, []);
        byTarget.get(c.to).push(c.id);
    }
    let written = 0;
    for (const [rate, ids] of byTarget) {
        written += await prisma.$executeRawUnsafe(
            'UPDATE "Warehouse" SET "ratePerSqft" = $1 WHERE "id" = ANY($2::int[])', rate, ids,
        );
    }
    console.log(`\nwritten: ${written} rows across ${byTarget.size} distinct rates`);

    const bad = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM "Warehouse"
         WHERE regexp_replace(COALESCE("ratePerSqft",''), '[^0-9.]','','g') LIKE '.%'`);
    console.log(`rows still misparsing to a sub-₹1 rate: ${bad[0].n}`);
    await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
