/**
 * Lift structured facts out of the legacy free-text columns into the columns that
 * exist for them.
 *
 * `otherSpecifications` (1,396 rows) and `compliances` (2,170) predate most of the
 * structured spec fields, so facts that now have a home were written as prose and
 * the real column left empty. This moves four of them. Each rule below was checked
 * against the actual text before being written down.
 *
 * DELIBERATELY NOT EXTRACTED, after inspection:
 *   - wallAndSecurityRoom (175 candidates) — the target is itself free text
 *     ("Security Room, CCTV", "Available", "Availble", "APCR"), so this would be
 *     duplication, not structuring, and gives the same fact two places to drift.
 *   - fire_compliance_cert_type (164 rows where compliances is exactly "Fire NOC")
 *     — same reason; that column's own vocabulary is inconsistent.
 *   - the 456 washroom mentions with no number — washroom_count is a COUNT, and
 *     writing "Available" into it recreates the junk already cleaned out of it.
 *     Those rows do carry a real fact (a washroom exists) with nowhere to put it;
 *     that is a missing boolean, i.e. a migration, not a backfill.
 *   - the 169 rows saying only "water" — names no supply type, so it cannot pick
 *     a WaterSupply enum value.
 *
 * Only ever writes where the target column is empty; never overwrites.
 * Provenance is appended to scoutNotes so a reviewer can see what a value was read
 * from without digging through the rollback file.
 *
 * DEFAULT IS --dry-run.
 *
 *   node -r dotenv/config scripts/extractFromFreeText.js
 *   node -r dotenv/config scripts/extractFromFreeText.js --apply
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');
const SNAPSHOT = path.join(__dirname, '..', 'tools',
    `freetext-extract-snapshot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.rollback.sql`);

const isEmpty = (v) => v === null || v === undefined || String(v).trim() === '';

/**
 * Each rule: which column it fills, how to recognise a value, and the SQL type to
 * cast to. `match` returns { value, phrase } or null. `phrase` is the snippet the
 * value was read from, quoted verbatim into scoutNotes.
 */
const snippet = (text, re) => {
    const m = text.match(re);
    if (!m) return null;
    const at = m.index;
    return text.slice(Math.max(0, at - 24), Math.min(text.length, at + m[0].length + 24)).replace(/\s+/g, ' ').trim();
};

const RULES = [
    {
        column: 'waterSupply', sqlType: '"WaterSupply"',
        // The enum names a supply TYPE. "water" alone cannot choose one, so only an
        // explicitly named source qualifies.
        match: (t) => {
            if (/borewell|bore\s?well|bore-well/i.test(t)) return { value: 'BOREWELL', phrase: snippet(t, /borewell|bore\s?well|bore-well/i) };
            if (/pipeline|pipe line|corporation water|municipal water/i.test(t)) return { value: 'PIPELINE', phrase: snippet(t, /pipeline|pipe line|corporation water|municipal water/i) };
            if (/tanker/i.test(t)) return { value: 'TANKER', phrase: snippet(t, /tanker/i) };
            return null;
        },
    },
    {
        column: 'flooringType', sqlType: 'text',
        // Named flooring systems only. A bare "flooring"/"floor" says nothing about type.
        match: (t) => {
            if (/\bvdf\b/i.test(t)) return { value: 'VDF', phrase: snippet(t, /\bvdf\b/i) };
            if (/\bfm-?\s?2\b/i.test(t)) return { value: 'FM2', phrase: snippet(t, /\bfm-?\s?2\b/i) };
            if (/trimix/i.test(t)) return { value: 'Trimix', phrase: snippet(t, /trimix/i) };
            return null;
        },
    },
    {
        column: 'liftAccess', sqlType: 'boolean',
        // "provision" means provision FOR a lift, not an installed one — excluded.
        match: (t) => {
            if (/lift\s+provision|provision\s+for\s+(a\s+)?lift/i.test(t)) return null;
            const re = /goods\s?lift(ing)?|passenger\s+lift|pax\s+lift|\blift\b|elevator/i;
            if (!re.test(t)) return null;
            return { value: 'true', phrase: snippet(t, re) };
        },
    },
    {
        column: 'washroom_count', sqlType: 'text',
        // Only where a digit actually precedes the word. A bare mention is not a count.
        match: (t) => {
            const re = /(\d+)\s*(?:plus\s*)?(?:nos?\.?\s*)?(?:washrooms?|toilets?|rest\s?rooms?)/i;
            const m = t.match(re);
            if (!m) return null;
            const n = parseInt(m[1], 10);
            if (!Number.isFinite(n) || n < 1 || n > 40) return null;
            return { value: String(n), phrase: snippet(t, re) };
        },
    },
];

function scriptClient() {
    const url = process.env.DATABASE_URL || '';
    const withLimit = /connection_limit=\d+/.test(url)
        ? url.replace(/connection_limit=\d+/, 'connection_limit=1')
        : url + (url.includes('?') ? '&' : '?') + 'connection_limit=1';
    return new PrismaClient({ datasources: { db: { url: withLimit } } });
}

async function main() {
    const prisma = scriptClient();
    const cols = ['id', 'otherSpecifications', 'compliances', 'scoutNotes', ...RULES.map((r) => r.column)];
    const rows = await prisma.warehouse.findMany({ select: Object.fromEntries(cols.map((c) => [c, true])) });

    const perRule = new Map(RULES.map((r) => [r.column, []]));
    const notesFor = new Map();

    for (const r of rows) {
        const text = `${r.otherSpecifications || ''} | ${r.compliances || ''}`;
        if (!text.trim() || text.trim() === '|') continue;
        for (const rule of RULES) {
            if (!isEmpty(r[rule.column])) continue;          // never overwrite
            const hit = rule.match(text);
            if (!hit) continue;
            perRule.get(rule.column).push({ id: r.id, value: hit.value, phrase: hit.phrase });
            const line = `[spec-extraction] ${rule.column} = ${hit.value} — read from: "${hit.phrase}"`;
            if (!notesFor.has(r.id)) notesFor.set(r.id, { existing: r.scoutNotes, lines: [] });
            notesFor.get(r.id).lines.push(line);
        }
    }

    console.log(`mode: ${APPLY ? 'APPLY' : 'dry-run'}   ${rows.length} rows scanned\n`);
    let total = 0;
    for (const rule of RULES) {
        const hits = perRule.get(rule.column);
        total += hits.length;
        const byVal = new Map();
        for (const h of hits) byVal.set(h.value, (byVal.get(h.value) || 0) + 1);
        console.log(`=== ${rule.column}: ${hits.length} rows ===`);
        for (const [v, n] of [...byVal].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  -> ${v}`);
        for (const h of hits.slice(0, 3)) console.log(`     eg ${h.id}: "${h.phrase}"`);
        console.log();
    }
    console.log(`total: ${total} values across ${notesFor.size} rows`);

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

    // Rollback restores the target to NULL and scoutNotes to exactly what it was.
    const q = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
    const lines = [];
    for (const rule of RULES) {
        for (const h of perRule.get(rule.column)) lines.push(`UPDATE "Warehouse" SET "${rule.column}"=NULL WHERE "id"=${h.id};`);
    }
    for (const [id, n] of notesFor) lines.push(`UPDATE "Warehouse" SET "scoutNotes"=${q(n.existing)} WHERE "id"=${id};`);
    fs.writeFileSync(SNAPSHOT, lines.join('\n') + '\n');
    console.log(`\nrollback SQL -> ${SNAPSHOT}`);

    // unnest-join updates: many distinct values in one statement, and raw SQL so
    // `status_updated_at` (@updatedAt, shown to users) is not stamped.
    let written = 0;
    for (const rule of RULES) {
        const hits = perRule.get(rule.column);
        if (!hits.length) continue;
        const n = await prisma.$executeRawUnsafe(
            `UPDATE "Warehouse" AS w SET "${rule.column}" = d.val::${rule.sqlType}
             FROM (SELECT unnest($1::int[]) AS id, unnest($2::text[]) AS val) d
             WHERE w.id = d.id`,
            hits.map((h) => h.id), hits.map((h) => h.value),
        );
        written += n;
        console.log(`  ${rule.column.padEnd(16)} ${n}`);
    }

    const ids = [...notesFor.keys()];
    const notes = ids.map((id) => {
        const { existing, lines: ls } = notesFor.get(id);
        return existing && existing.trim() ? `${existing.trim()}\n${ls.join('\n')}` : ls.join('\n');
    });
    const noteRows = await prisma.$executeRawUnsafe(
        `UPDATE "Warehouse" AS w SET "scoutNotes" = d.notes
         FROM (SELECT unnest($1::int[]) AS id, unnest($2::text[]) AS notes) d
         WHERE w.id = d.id`, ids, notes);
    console.log(`  scoutNotes stamped ${noteRows} rows`);
    console.log(`\nwritten: ${written} values across ${noteRows} rows`);
    await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
