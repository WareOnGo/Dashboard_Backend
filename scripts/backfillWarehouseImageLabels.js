/**
 * Backfill labeled_warehouse_images for every image in Warehouse.media.
 *
 * Resumable by design: it skips any imageUrl already present in the table, so
 * interrupting it and re-running costs nothing but the images not yet done.
 * Results are written in chunks rather than at the end, so a crash at 90% keeps
 * the first 90%.
 *
 * Images that error are deliberately NOT written, so a later run retries them.
 *
 * Only image URLs are sent to OpenAI; it fetches the bytes from R2 itself.
 *
 * Usage:
 *   node -r dotenv/config scripts/backfillWarehouseImageLabels.js [flags]
 *     --model=gpt-5.6-terra  model to label with (default gpt-5.6-terra)
 *     --url-cache=path.json  cache the (warehouseId, url) work list to disk
 *     --limit=200            only process N unlabelled images (trial runs)
 *     --concurrency=16       parallel API requests (default 16)
 *     --chunk=50             rows per database write (default 50)
 *     --detail=low           image detail: low | high | auto (default low)
 *     --relabel              re-label images already in the table
 *     --dry-run              report what would run, call no APIs, write nothing
 *     --error-log=path       failures, appended as JSONL as they happen
 *                            (default ./backfill-errors.jsonl)
 *     --recovery-log=path    labels parked when a database write fails for good
 *                            (default ./backfill-recovery.jsonl)
 *     --replay=path          insert parked labels from a recovery log and exit
 *
 * Recovering from a failure:
 *   - killed / crashed / Ctrl-C  -> re-run the same command; anything already
 *                                   in the table is skipped
 *   - images that errored        -> not written, so a re-run retries them;
 *                                   see the error log for which and why
 *   - database died mid-write    -> labels are parked in the recovery log, then
 *                                   `--replay=<recovery log>` inserts them
 */
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const { PRICING, classify, sleep } = require('../src/utils/imageClassifier');

const prisma = new PrismaClient();

const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};

const MODEL = arg('model', 'gpt-5.6-terra');
const URL_CACHE = arg('url-cache', null) && require('path').resolve(arg('url-cache'));
const LIMIT = arg('limit', null) ? Number(arg('limit')) : null;
const CONCURRENCY = Number(arg('concurrency', 16));
const CHUNK = Number(arg('chunk', 50));
const DETAIL = arg('detail', 'low');
const RELABEL = process.argv.includes('--relabel');
const DRY_RUN = process.argv.includes('--dry-run');
const ERROR_LOG = require('path').resolve(arg('error-log', 'backfill-errors.jsonl'));
const RECOVERY_LOG = require('path').resolve(arg('recovery-log', 'backfill-recovery.jsonl'));
const REPLAY = arg('replay', null) && require('path').resolve(arg('replay'));

/** Appends JSONL immediately, so a kill -9 still leaves a record on disk. */
const appendJsonl = (file, objs) => {
    if (objs.length) fs.appendFileSync(file, objs.map((o) => JSON.stringify(o)).join('\n') + '\n');
};

// Ctrl-C stops after the current chunk finishes writing rather than mid-write,
// so the table never ends up behind what has already been paid for.
let stopping = false;
process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log('\n! interrupt received — finishing current chunk, then stopping. Ctrl-C again to force.');
});

/**
 * The Supabase pooler rejects connections intermittently. Every DB call here is
 * wrapped, because losing a write means re-spending on images already paid for.
 */
async function withRetry(label, fn, attempts = 8) {
    for (let i = 0; ; i++) {
        try {
            return await fn();
        } catch (err) {
            if (i >= attempts - 1) throw err;
            const wait = Math.min(2 ** i, 15);
            console.warn(`  ! ${label} failed (attempt ${i + 1}/${attempts}), retrying in ${wait}s`);
            await sleep(wait * 1000);
        }
    }
}

const loadAllImages = () => withRetry('read images', () => prisma.$queryRawUnsafe(`
    SELECT w.id AS "warehouseId", img #>> '{}' AS "imageUrl"
    FROM "Warehouse" w,
         LATERAL jsonb_array_elements(COALESCE(w.media::jsonb->'images', '[]'::jsonb)) img
    WHERE jsonb_typeof(img) = 'string'
      AND img #>> '{}' ~* '\\.(jpe?g|png|webp|gif)$'
    ORDER BY w.id, 2
`));

const loadLabelled = () => withRetry('read existing labels', () =>
    prisma.labeledWarehouseImage.findMany({ select: { imageUrl: true } }));

/**
 * The work list is just (warehouseId, imageUrl) pairs — no image bytes, OpenAI
 * fetches those from R2 itself. Caching it to disk means the expensive media
 * scan hits the flaky pooler once rather than on every restart, and keeps the
 * list identical across resumes.
 */
async function resolveWorkList() {
    if (URL_CACHE && fs.existsSync(URL_CACHE)) {
        const cached = JSON.parse(fs.readFileSync(URL_CACHE, 'utf8'));
        console.log(`url list loaded from cache ${URL_CACHE} (${cached.length} images)`);
        return cached;
    }
    const all = await loadAllImages();
    // De-duplicate: the same URL can legitimately appear on more than one
    // warehouse, and imageUrl is unique in the table.
    const seen = new Set();
    const unique = all.filter((r) => !seen.has(r.imageUrl) && seen.add(r.imageUrl));
    if (URL_CACHE) {
        fs.writeFileSync(URL_CACHE, JSON.stringify(unique));
        console.log(`url list cached to ${URL_CACHE} (${unique.length} images, ${(fs.statSync(URL_CACHE).size / 1024).toFixed(0)} KB)`);
    }
    return unique;
}

async function runPool(items, worker, concurrency) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await worker(items[i], i);
        }
    }));
    return out;
}

/**
 * Inserts labels parked by a failed chunk write. These were already paid for,
 * so this costs nothing. Safe to run repeatedly — skipDuplicates makes it
 * idempotent, and the file is cleared only once every row is in.
 */
async function replay(file) {
    if (!fs.existsSync(file)) {
        console.log(`nothing to replay: ${file} does not exist`);
        return;
    }
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    console.log(`replaying ${rows.length} parked labels from ${file}`);
    let inserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
        const { count } = await withRetry('replay chunk', () =>
            prisma.labeledWarehouseImage.createMany({ data: rows.slice(i, i + CHUNK), skipDuplicates: true }));
        inserted += count;
    }
    fs.renameSync(file, `${file}.done`);
    console.log(`inserted ${inserted} (${rows.length - inserted} were already present); ${file} moved to ${file}.done`);
}

async function main() {
    if (REPLAY) return replay(REPLAY);

    if (!DRY_RUN && !process.env.OPENAI_API_KEY) {
        console.error('OPENAI_API_KEY is not set. Add it to .env and re-run with -r dotenv/config.');
        process.exit(1);
    }

    const unique = await resolveWorkList();

    let todo = unique;
    if (!RELABEL) {
        const done = new Set((await loadLabelled()).map((r) => r.imageUrl));
        todo = unique.filter((r) => !done.has(r.imageUrl));
        console.log(`${unique.length} unique images, ${done.size} already labelled, ${todo.length} to do`);
    } else {
        console.log(`${unique.length} unique images, --relabel set so all will be re-labelled`);
    }
    if (LIMIT) {
        todo = todo.slice(0, LIMIT);
        console.log(`--limit=${LIMIT}, processing ${todo.length}`);
    }
    if (!todo.length) {
        console.log('nothing to do.');
        return;
    }

    const price = PRICING[MODEL];
    if (price) {
        // ~594 input + ~48 output tokens per image, measured over the 100-image sample.
        const est = (todo.length * 594 / 1e6) * price.in + (todo.length * 48 / 1e6) * price.out;
        console.log(`model ${MODEL}, detail ${DETAIL}, concurrency ${CONCURRENCY} — estimated ~$${est.toFixed(2)}`);
    } else {
        console.warn(`! no pricing entry for "${MODEL}"`);
    }

    if (DRY_RUN) {
        console.log('dry run, stopping before any API call.');
        todo.slice(0, 10).forEach((r, i) => console.log(`  ${i + 1}  wh ${r.warehouseId}  ${r.imageUrl}`));
        if (todo.length > 10) console.log(`  ... and ${todo.length - 10} more`);
        return;
    }

    const started = Date.now();
    let written = 0, failed = 0, stranded = 0, inTok = 0, outTok = 0;
    const errors = [];

    for (let offset = 0; offset < todo.length; offset += CHUNK) {
        const batch = todo.slice(offset, offset + CHUNK);
        const results = await runPool(batch, (row) => classify(MODEL, row.imageUrl, { detail: DETAIL }), CONCURRENCY);

        const rows = [];
        const chunkErrors = [];
        results.forEach((res, i) => {
            if (res.error) {
                failed++;
                const e = { warehouseId: batch[i].warehouseId, imageUrl: batch[i].imageUrl, error: res.error, at: new Date().toISOString() };
                errors.push(e);
                chunkErrors.push(e);
                return;
            }
            inTok += res.inputTokens;
            outTok += res.outputTokens;
            rows.push({
                warehouseId: batch[i].warehouseId,
                imageUrl: batch[i].imageUrl,
                classification: res.classification,
                description: res.description,
                model: MODEL,
                confidence: res.confidence,
            });
        });

        // Record failures as they happen, not at the end — an interrupted run
        // must still say which images to look at.
        appendJsonl(ERROR_LOG, chunkErrors);

        if (rows.length) {
            try {
                // createMany + skipDuplicates, not an interactive transaction: the
                // pooler does not support those (P2028). skipDuplicates makes a
                // re-run over the same chunk harmless.
                const { count } = await withRetry('write chunk', () =>
                    prisma.labeledWarehouseImage.createMany({ data: rows, skipDuplicates: true }));
                written += count;
            } catch (err) {
                // These labels are already paid for. Park them on disk and keep
                // going rather than dropping them and billing for them twice;
                // --replay inserts them once the database is healthy again.
                appendJsonl(RECOVERY_LOG, rows);
                stranded += rows.length;
                console.error(`  !! chunk write failed permanently (${err.message.split('\n')[0]})`);
                console.error(`     ${rows.length} labels parked in ${RECOVERY_LOG} — replay with --replay=${RECOVERY_LOG}`);
            }
        }

        const pct = Math.round(((offset + batch.length) / todo.length) * 100);
        const elapsed = (Date.now() - started) / 1000;
        const rate = (offset + batch.length) / elapsed;
        const eta = Math.round((todo.length - offset - batch.length) / rate);
        console.log(`  ${pct}%  ${written} written, ${failed} failed${stranded ? `, ${stranded} stranded` : ''}  ${rate.toFixed(1)} img/s  eta ${Math.floor(eta / 60)}m${eta % 60}s`);

        if (stopping) {
            console.log(`\nstopped after ${offset + batch.length}/${todo.length}. Re-run the same command to continue.`);
            break;
        }
    }

    const cost = price ? (inTok / 1e6) * price.in + (outTok / 1e6) * price.out : null;
    console.log(`\ndone in ${Math.round((Date.now() - started) / 1000)}s`);
    console.log(`written ${written}, failed ${failed}${stranded ? `, stranded ${stranded}` : ''}`);
    if (stranded) console.log(`! ${stranded} labels parked — run with --replay=${RECOVERY_LOG} to insert them`);
    console.log(`tokens in ${inTok}, out ${outTok}${cost === null ? '' : `, actual cost $${cost.toFixed(2)}`}`);

    if (errors.length) {
        console.log(`\n${errors.length} errors, logged to ${ERROR_LOG} (not written — re-run to retry them):`);
        for (const e of errors.slice(0, 15)) console.log(`  ${e.imageUrl}\n    ${e.error}`);
        if (errors.length > 15) console.log(`  ... and ${errors.length - 15} more`);
    }

    const dist = await withRetry('read distribution', () =>
        prisma.labeledWarehouseImage.groupBy({ by: ['classification'], _count: true }));
    console.log('\ntable totals:');
    for (const d of dist.sort((a, b) => b._count - a._count)) console.log(`  ${d.classification.padEnd(9)} ${d._count}`);
}

main()
    .catch((err) => {
        console.error(err);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
