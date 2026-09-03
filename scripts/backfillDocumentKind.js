/**
 * Sub-label DOCUMENT images as LAYOUT / PAPERWORK / OTHER_DOCUMENT.
 *
 * WHY. DOCUMENT is one bucket holding two unrelated things: drawings that belong
 * on a client deck, and paperwork that must never reach one. v3 gives a layout a
 * slide of its own, and the picker currently asks a human to spot them by eye.
 *
 * Runs only over images already classified DOCUMENT — 223 of ~14,000 — so it is a
 * cheap question asked of the few images it applies to, rather than an extra field
 * on every photograph's scene prompt.
 *
 * DEFAULT IS --dry-run: it writes a JSONL for inspection and touches nothing. The
 * point of the first pass is to find out whether the model can do this at all, and
 * that is a question you answer by looking at the images next to their labels, not
 * by reading a distribution.
 *
 * Usage:
 *   node -r dotenv/config scripts/backfillDocumentKind.js --limit=40
 *   node -r dotenv/config scripts/backfillDocumentKind.js --apply
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const {
    classifyDocumentKind, DOC_KINDS, PRICING, sleep,
} = require('../src/utils/imageClassifier');

const arg = (n, d) => {
    const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.split('=').slice(1).join('=') : d;
};
const APPLY = process.argv.includes('--apply');
const LIMIT = Number(arg('limit', 0)) || null;
const MODEL = arg('model', process.env.IMAGE_LABEL_MODEL || 'gpt-5.6-terra');
const CONCURRENCY = Number(arg('concurrency', 4));
const OUT = arg('out', path.join(__dirname, '..', 'tools', 'highway-entry', 'document-kinds.jsonl'));

function scriptClient() {
    const url = process.env.DATABASE_URL || '';
    return new PrismaClient({
        datasources: { db: { url: url.replace(/connection_limit=\d+/, 'connection_limit=1') } },
    });
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(label, fn, attempts = 4) {
    for (let i = 1; ; i++) {
        try {
            return await fn();
        } catch (err) {
            if (i >= attempts) throw err;
            await sleepMs(1000 * 2 ** (i - 1));
            console.error(`  ${label} retry ${i}/${attempts}`);
        }
    }
}

/** Does the database have somewhere to put this yet? Checked, not assumed. */
async function columnExists(prisma) {
    const rows = await prisma.$queryRawUnsafe(`
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'labeled_warehouse_images' AND column_name = 'documentKind'`);
    return rows.length > 0;
}

(async () => {
    const prisma = scriptClient();
    const hasColumn = await withRetry('column check', () => columnExists(prisma));

    if (APPLY && !hasColumn) {
        console.error('Cannot --apply: labeled_warehouse_images has no documentKind column yet.');
        console.error('Run the dry pass first, look at the results, then add the column.');
        process.exit(2);
    }

    const rows = await withRetry('fetch', () => prisma.labeledWarehouseImage.findMany({
        where: { classification: 'DOCUMENT' },
        select: { id: true, warehouseId: true, imageUrl: true, description: true },
        orderBy: { id: 'asc' },
        ...(LIMIT ? { take: LIMIT } : {}),
    }));
    console.log(`${rows.length} DOCUMENT images${LIMIT ? ` (limited to ${LIMIT})` : ''}, model ${MODEL}`);
    console.log(APPLY ? '  APPLY: results will be written to the database' : '  dry run: nothing will be written');

    const results = [];
    let inTok = 0;
    let outTok = 0;
    let failed = 0;

    // A small pool: the API tolerates it and 223 images serially would take ten
    // minutes for no reason.
    let cursor = 0;
    const worker = async () => {
        for (;;) {
            const i = cursor;
            cursor += 1;
            if (i >= rows.length) return;
            const row = rows[i];
            const r = await classifyDocumentKind(MODEL, row.imageUrl);
            if (r.error || !DOC_KINDS.includes(r.documentKind)) {
                failed += 1;
                results.push({ ...row, error: r.error || `bad kind: ${r.documentKind}` });
            } else {
                inTok += r.inputTokens || 0;
                outTok += r.outputTokens || 0;
                results.push({
                    id: row.id,
                    warehouseId: row.warehouseId,
                    imageUrl: row.imageUrl,
                    sceneDescription: row.description,
                    documentKind: r.documentKind,
                    reason: r.reason,
                    confidence: r.confidence,
                });
            }
            if ((results.length % 25) === 0) process.stdout.write(`\r  ${results.length}/${rows.length}`);
            await sleep(60);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));
    process.stdout.write('\n');

    results.sort((a, b) => a.id - b.id);
    fs.writeFileSync(OUT, results.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const counts = results.reduce((acc, r) => {
        const k = r.error ? 'ERROR' : r.documentKind;
        acc[k] = (acc[k] || 0) + 1;
        return acc;
    }, {});
    console.log('\n=== distribution ===');
    for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${k.padEnd(16)}${String(v).padStart(4)}  ${((v / results.length) * 100).toFixed(1)}%`);
    }

    const ok = results.filter((r) => !r.error);
    const lowConf = ok.filter((r) => (r.confidence ?? 1) < 0.7);
    console.log(`\n  confidence below 0.7: ${lowConf.length} — these are the ones to eyeball first`);

    const price = PRICING[MODEL];
    if (price) {
        const usd = (inTok / 1e6) * price.in + (outTok / 1e6) * price.out;
        console.log(`  tokens ${inTok} in / ${outTok} out -> $${usd.toFixed(3)}`);
    }
    if (failed) console.log(`  failed: ${failed}`);
    console.log(`\n  written to ${OUT}`);

    if (!APPLY) {
        console.log('  Re-run with --apply once the column exists and the labels look right.');
        await prisma.$disconnect();
        return;
    }

    let written = 0;
    for (const r of ok) {
        // eslint-disable-next-line no-await-in-loop
        written += await withRetry(`write ${r.id}`, () => prisma.$executeRawUnsafe(
            'UPDATE labeled_warehouse_images SET "documentKind" = $1::"DocumentKind" WHERE id = $2',
            r.documentKind, r.id,
        ));
    }
    console.log(`  wrote ${written} sub-labels`);
    await prisma.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
