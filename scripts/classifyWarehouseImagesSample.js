/**
 * Sample harness for the warehouse-image classification experiment.
 *
 * Classifies a reproducible random sample of Warehouse.media images as
 * INDOOR / OUTDOOR / DOCUMENT (or UNKNOWN) so we can compare model tiers on
 * accuracy and cost BEFORE committing to a full run over all ~12.7k images.
 * This script is read-only against the database: it writes a JSON report and
 * prints a summary, and never touches LabeledWarehouseImage.
 *
 * The sample is seeded, so every model in a run sees the exact same images and
 * the results are directly comparable. Re-running with the same --seed and --n
 * reproduces the same sample.
 *
 * Requires OPENAI_API_KEY in the environment (or .env, via `-r dotenv/config`).
 *
 * Usage:
 *   node -r dotenv/config scripts/classifyWarehouseImagesSample.js [flags]
 *     --n=100            sample size (default 60)
 *     --seed=42          sample seed (default 42)
 *     --models=a,b       comma-separated models
 *                        (default gpt-5.6-luna,gpt-5.6-sol)
 *     --detail=low       image detail: low | high | auto (default low)
 *     --concurrency=8    parallel requests per model (default 8)
 *     --out=path.json    report path (default ./image-classification-sample.json)
 *     --csv=path.csv     also write a wide CSV, one row per image
 *                        (default alongside --out)
 *     --dry-run          build + print the sample, call no APIs
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { LABELS, PRICING, classify, sleep } = require('../src/utils/imageClassifier');

const prisma = new PrismaClient();

const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};

const N = Number(arg('n', 60));
const SEED = Number(arg('seed', 42));
const MODELS = arg('models', 'gpt-5.6-luna,gpt-5.6-sol').split(',').map((m) => m.trim()).filter(Boolean);
const DETAIL = arg('detail', 'low');
const CONCURRENCY = Number(arg('concurrency', 8));
const OUT = path.resolve(arg('out', 'image-classification-sample.json'));
const CSV_OUT = path.resolve(arg('csv', OUT.replace(/\.json$/, '') + '.csv'));
const CACHE = arg('sample-cache', null) && path.resolve(arg('sample-cache'));
const DRY_RUN = process.argv.includes('--dry-run');

/** Deterministic PRNG so a given --seed always yields the same sample. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function sample(items, n, seed) {
    const rand = mulberry32(seed);
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, n);
}

/**
 * The Supabase pooler rejects connections intermittently — in practice it can
 * take several attempts in a row before one lands. This is the only DB call in
 * the run and everything after it costs money, so retry patiently rather than
 * sinking a run that has already been paid for.
 */
async function loadImagesWithRetry(attempts = 10) {
    for (let i = 0; ; i++) {
        try {
            return await loadImages();
        } catch (err) {
            if (i >= attempts - 1) throw err;
            const wait = Math.min(2 ** i, 15);
            console.warn(`db read failed (attempt ${i + 1}/${attempts}), retrying in ${wait}s`);
            await sleep(wait * 1000);
        }
    }
}

/**
 * Caches the drawn sample to disk. The pooler is unreliable enough that a rerun
 * shouldn't have to touch the database again — and reusing the cached list also
 * guarantees a rerun scores the exact same images as the run before it.
 */
async function resolveSample() {
    if (CACHE && fs.existsSync(CACHE)) {
        const cached = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
        if (cached.picked.length > N) {
            // Honour --n against a larger cache. The sample is a prefix of a
            // seeded shuffle, so the first N are themselves a valid sample.
            console.log(`sample from cache ${CACHE}, taking first ${N} of ${cached.picked.length}`);
            return { ...cached, picked: cached.picked.slice(0, N) };
        }
        console.log(`sample loaded from cache ${CACHE} (${cached.picked.length} images, pool ${cached.poolSize})`);
        return cached;
    }
    const all = await loadImagesWithRetry();
    const picked = sample(all, N, SEED);
    console.log(`${all.length} images in pool across ${new Set(all.map((r) => r.warehouseId)).size} warehouses`);
    const result = { poolSize: all.length, picked };
    if (CACHE) {
        fs.writeFileSync(CACHE, JSON.stringify(result, null, 2));
        console.log(`sample cached to ${CACHE}`);
    }
    return result;
}

async function loadImages() {
    // Sorted by (id, url) so the candidate pool is stable regardless of how
    // Postgres returns rows — the seeded shuffle is only reproducible if its
    // input order is.
    return prisma.$queryRawUnsafe(`
        SELECT w.id AS "warehouseId", img #>> '{}' AS "imageUrl"
        FROM "Warehouse" w,
             LATERAL jsonb_array_elements(COALESCE(w.media::jsonb->'images', '[]'::jsonb)) img
        WHERE jsonb_typeof(img) = 'string'
          AND img #>> '{}' ~* '\\.(jpe?g|png|webp|gif)$'
        ORDER BY w.id, 2
    `);
}

async function runPool(items, worker, concurrency) {
    const out = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await worker(items[i], i);
        }
    });
    await Promise.all(runners);
    return out;
}

function summarise(model, results, totalImages) {
    const ok = results.filter((r) => !r.error);
    const failed = results.length - ok.length;
    const dist = Object.fromEntries(LABELS.map((l) => [l, ok.filter((r) => r.classification === l).length]));

    const inTok = ok.reduce((s, r) => s + r.inputTokens, 0);
    const outTok = ok.reduce((s, r) => s + r.outputTokens, 0);
    const price = PRICING[model];
    const cost = price ? (inTok / 1e6) * price.in + (outTok / 1e6) * price.out : null;

    const latencies = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
    const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.5)] : 0;
    const p95 = latencies.length ? latencies[Math.floor(latencies.length * 0.95)] : 0;

    return {
        model,
        ok: ok.length,
        failed,
        distribution: dist,
        meanConfidence: ok.length ? ok.reduce((s, r) => s + (r.confidence || 0), 0) / ok.length : 0,
        inputTokens: inTok,
        outputTokens: outTok,
        avgInputTokens: ok.length ? Math.round(inTok / ok.length) : 0,
        sampleCostUsd: cost,
        projectedFullRunUsd: cost && ok.length ? (cost / ok.length) * totalImages : null,
        projectedFullRunBatchUsd: cost && ok.length ? ((cost / ok.length) * totalImages) / 2 : null,
        p50LatencyMs: p50,
        p95LatencyMs: p95,
    };
}

const csvCell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Wide CSV: one row per image, one column group per model, so the whole
 * comparison can be eyeballed or sorted in a spreadsheet. `allAgree` and
 * `majority` are derived here so disagreements can be filtered on directly.
 */
function writeCsv(rows, models, file) {
    const header = ['warehouseId', 'imageUrl', 'allAgree', 'majority'];
    for (const m of models) header.push(`${m}__label`, `${m}__confidence`, `${m}__description`, `${m}__error`);

    const lines = [header.map(csvCell).join(',')];
    for (const r of rows) {
        const labels = models.map((m) => r.results[m].classification).filter(Boolean);
        const counts = {};
        for (const l of labels) counts[l] = (counts[l] || 0) + 1;
        const majority = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];

        const cells = [
            r.warehouseId,
            r.imageUrl,
            labels.length && new Set(labels).size === 1 ? 'yes' : 'no',
            majority ? majority[0] : '',
        ];
        for (const m of models) {
            const x = r.results[m] || {};
            cells.push(x.classification || '', x.confidence ?? '', x.description || '', x.error || '');
        }
        lines.push(cells.map(csvCell).join(','));
    }
    fs.writeFileSync(file, lines.join('\n') + '\n');
}

async function main() {
    if (!DRY_RUN && !process.env.OPENAI_API_KEY) {
        console.error('OPENAI_API_KEY is not set. Add it to .env and re-run with -r dotenv/config.');
        process.exit(1);
    }
    for (const m of MODELS) {
        if (!PRICING[m]) console.warn(`! no pricing entry for "${m}" — cost will be reported as null`);
    }

    const { poolSize, picked } = await resolveSample();
    console.log(`sampling ${picked.length} (seed ${SEED}, detail ${DETAIL})\n`);

    if (DRY_RUN) {
        picked.forEach((p, i) => console.log(`${String(i + 1).padStart(3)}  wh ${String(p.warehouseId).padEnd(6)} ${p.imageUrl}`));
        return;
    }

    const byModel = {};
    for (const model of MODELS) {
        process.stdout.write(`${model}: `);
        let done = 0;
        byModel[model] = await runPool(picked, async (row) => {
            const r = await classify(model, row.imageUrl, { detail: DETAIL });
            done++;
            if (done % 10 === 0) process.stdout.write(`${done} `);
            return r;
        }, CONCURRENCY);
        console.log(`done`);
    }

    // Per-image rows, one column per model, for eyeballing side by side.
    const rows = picked.map((p, i) => ({
        warehouseId: p.warehouseId,
        imageUrl: p.imageUrl,
        results: Object.fromEntries(MODELS.map((m) => [m, byModel[m][i]])),
    }));

    const summaries = MODELS.map((m) => summarise(m, byModel[m], poolSize));

    console.log('\n=== per-model summary ===');
    for (const s of summaries) {
        const cost = s.sampleCostUsd === null ? 'n/a' : `$${s.sampleCostUsd.toFixed(4)}`;
        const full = s.projectedFullRunUsd === null ? 'n/a'
            : `$${s.projectedFullRunUsd.toFixed(2)} (batch $${s.projectedFullRunBatchUsd.toFixed(2)})`;
        console.log(`\n${s.model}`);
        console.log(`  ok ${s.ok}/${s.ok + s.failed}  failed ${s.failed}`);
        console.log(`  labels ${LABELS.map((l) => `${l}:${s.distribution[l]}`).join('  ')}`);
        console.log(`  mean self-reported confidence ${s.meanConfidence.toFixed(3)}`);
        console.log(`  tokens in ${s.inputTokens} (avg ${s.avgInputTokens}/img)  out ${s.outputTokens}`);
        console.log(`  sample cost ${cost}   projected ${poolSize} images: ${full}`);
        console.log(`  latency p50 ${s.p50LatencyMs}ms  p95 ${s.p95LatencyMs}ms`);
    }

    // Cross-model agreement. Agreement is not accuracy — it tells us whether the
    // cheap model tracks the expensive one, which is the actual decision here.
    const agreement = [];
    for (let a = 0; a < MODELS.length; a++) {
        for (let b = a + 1; b < MODELS.length; b++) {
            const [ma, mb] = [MODELS[a], MODELS[b]];
            const comparable = rows.filter((r) => !r.results[ma].error && !r.results[mb].error);
            const agree = comparable.filter((r) => r.results[ma].classification === r.results[mb].classification);
            const disagreements = comparable
                .filter((r) => r.results[ma].classification !== r.results[mb].classification)
                .map((r) => ({
                    warehouseId: r.warehouseId,
                    imageUrl: r.imageUrl,
                    [ma]: r.results[ma].classification,
                    [mb]: r.results[mb].classification,
                }));
            agreement.push({
                models: [ma, mb],
                compared: comparable.length,
                agreed: agree.length,
                rate: comparable.length ? agree.length / comparable.length : null,
                disagreements,
            });
        }
    }

    for (const a of agreement) {
        console.log(`\n=== ${a.models[0]} vs ${a.models[1]} ===`);
        console.log(`  agreed on ${a.agreed}/${a.compared} (${(a.rate * 100).toFixed(1)}%)`);
        for (const d of a.disagreements) {
            console.log(`  wh ${String(d.warehouseId).padEnd(6)} ${d[a.models[0]]} vs ${d[a.models[1]]}  ${d.imageUrl}`);
        }
    }

    const errors = rows.flatMap((r) => MODELS
        .filter((m) => r.results[m].error)
        .map((m) => ({ model: m, imageUrl: r.imageUrl, error: r.results[m].error })));
    if (errors.length) {
        console.log(`\n=== ${errors.length} errors ===`);
        for (const e of errors.slice(0, 20)) console.log(`  [${e.model}] ${e.imageUrl}\n    ${e.error}`);
        if (errors.length > 20) console.log(`  ... and ${errors.length - 20} more (see report)`);
    }

    fs.writeFileSync(OUT, JSON.stringify({
        generatedAt: new Date().toISOString(),
        config: { n: N, seed: SEED, models: MODELS, detail: DETAIL, poolSize: poolSize },
        summaries,
        agreement,
        rows,
    }, null, 2));
    writeCsv(rows, MODELS, CSV_OUT);
    console.log(`\nreport written to ${OUT}`);
    console.log(`csv written to    ${CSV_OUT}`);
    console.log('Review the rows, then decide a model before running the full ~12.7k-image pass.');
}

main()
    .catch((err) => {
        console.error(err);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
