/**
 * Collapse the name-form spellings of `Warehouse.uploadedBy` onto each person's
 * canonical address.
 *
 * WHY. Attribution is split across up to four spellings per person — Dhaval's 521
 * listings sit under 'Dhaval', 'dhaval@wareongo.com', 'Dhaval Gupta' and ' Dhaval'
 * (with a leading space). Email is already what the system writes on its own
 * authenticated path (`uploadedBy: req.user.email`, warehouseController.js:416 and
 * :500) and what the scout path prefers (`scout.email || scout.name`, :456), so the
 * email form is the canonical one and this aligns the legacy rows with it.
 *
 * Addresses are taken from the VerifiedNumber roster, not invented. Mukesh's
 * canonical address is his gmail, at the user's instruction — he has no
 * @wareongo.com address on the roster.
 *
 * SCOPE: the five people named. Deliberately NOT included, though they have the
 * same shape — raise them separately:
 *   - Anshu (22 + 17) and Deepak (17 + 2), both of whom DO have roster addresses;
 *   - Dhanunjaya V (59 + 1), who has no roster address, so there is no email form
 *     to normalise onto;
 *   - the initials JC (302 rows), AS (17), JV (13), JJ (7), RS (1), which no roster
 *     entry decodes — a script cannot guess who they are;
 *   - 'test' and one row reading 'RCC', which are junk rather than people.
 *
 * NOTE: this will re-rot. WarehouseForm.jsx:912 is a free-text input whose tooltip
 * reads "Mention your name", so manually-entered listings keep arriving as names.
 *
 * DEFAULT IS --dry-run.
 *
 *   node -r dotenv/config scripts/normalizeUploadedBy.js
 *   node -r dotenv/config scripts/normalizeUploadedBy.js --apply
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');
const SNAPSHOT = path.join(__dirname, '..', 'tools', `uploadedby-snapshot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.rollback.sql`);

/**
 * Variant (trimmed, lowercased) -> canonical identity. Every target is verified
 * against the VerifiedNumber roster at runtime — as an email where the person has
 * one, otherwise as their roster name.
 */
const MAP = new Map(Object.entries({
    // Applied 2026-09-14. Retained so a re-run is a no-op rather than a gap.
    'dhaval': 'dhaval@wareongo.com',
    'dhaval gupta': 'dhaval@wareongo.com',
    'nikesh': 'nikesh@wareongo.com',
    'nikesh gupta': 'nikesh@wareongo.com',
    'ranita': 'ranita@wareongo.com',
    'nagaraj': 'nagaraj@wareongo.com',
    'nagaraj m': 'nagaraj@wareongo.com',
    'mukesh': 'qamukesh1990@gmail.com',

    // Initials resolved by correlating Warehouse.createdAt against
    // MessageLog.received_at per sender_number, then matching the number to
    // VerifiedNumber. Each of these had one sender at ~100% within ±15 minutes with
    // the next-best far behind; see the table in the commit message. Jayant Varkala
    // and Dhanunjaya have no roster email, so they normalise to their roster NAME —
    // there is no @wareongo form to use.
    'as': 'arnav@wareongo.com',
    'jv': 'Jayant Varkala',
    'jj': 'Jayant Varkala',
    'dhanunjaya v': 'Dhanunjaya',
}));

function scriptClient() {
    const url = process.env.DATABASE_URL || '';
    const withLimit = /connection_limit=\d+/.test(url)
        ? url.replace(/connection_limit=\d+/, 'connection_limit=1')
        : url + (url.includes('?') ? '&' : '?') + 'connection_limit=1';
    return new PrismaClient({ datasources: { db: { url: withLimit } } });
}

async function main() {
    const prisma = scriptClient();

    // Verify every target actually exists on the roster before writing it anywhere,
    // as an email or as a name. A typo'd identity would be worse than the mess it
    // replaces, because it would look canonical.
    const roster = await prisma.verifiedNumber.findMany({ select: { name: true, email: true } });
    const emails = new Set(roster.map((r) => r.email).filter(Boolean));
    const names = new Set(roster.map((r) => r.name).filter(Boolean));
    const targets = [...new Set(MAP.values())];
    const unknown = targets.filter((t) => !emails.has(t) && !names.has(t));
    if (unknown.length) {
        console.error(`refusing to run: targets not on the VerifiedNumber roster: ${unknown.join(', ')}`);
        await prisma.$disconnect();
        process.exit(1);
    }
    for (const t of targets) {
        console.log(`  roster-confirmed: ${t.padEnd(26)} (${emails.has(t) ? 'email' : 'name, no email on file'})`);
    }
    console.log();

    const rows = await prisma.warehouse.findMany({ select: { id: true, uploadedBy: true } });
    const changes = [];
    for (const r of rows) {
        if (!r.uploadedBy) continue;
        const to = MAP.get(r.uploadedBy.trim().toLowerCase());
        if (to && to !== r.uploadedBy) changes.push({ id: r.id, from: r.uploadedBy, to });
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

    // Per-person totals after the run, so the consolidation is visible.
    console.log('\n=== resulting totals per person ===');
    for (const t of targets) {
        const before = rows.filter((r) => r.uploadedBy === t).length;
        const moving = changes.filter((c) => c.to === t).length;
        console.log(`  ${t.padEnd(26)} ${String(before).padStart(4)} + ${String(moving).padStart(4)} = ${before + moving}`);
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
    fs.writeFileSync(SNAPSHOT, changes.map((c) => `UPDATE "Warehouse" SET "uploadedBy"=${q(c.from)} WHERE "id"=${c.id};`).join('\n') + '\n');
    console.log(`\nrollback SQL -> ${SNAPSHOT}`);

    const byTarget = new Map();
    for (const c of changes) {
        if (!byTarget.has(c.to)) byTarget.set(c.to, []);
        byTarget.get(c.to).push(c.id);
    }
    let written = 0;
    for (const [email, ids] of byTarget) {
        const n = await prisma.$executeRawUnsafe(
            'UPDATE "Warehouse" SET "uploadedBy" = $1 WHERE "id" = ANY($2::int[])', email, ids);
        written += n;
        console.log(`  ${email.padEnd(26)} ${n}`);
    }
    console.log(`\nwritten: ${written} rows`);

    const after = await prisma.$queryRawUnsafe(
        `SELECT "uploadedBy" AS v, COUNT(*)::int AS n FROM "Warehouse" GROUP BY 1 ORDER BY n DESC`);
    console.log(`distinct uploaders now: ${after.length}`);
    await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
