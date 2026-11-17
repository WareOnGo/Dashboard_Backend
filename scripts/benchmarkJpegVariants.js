// Read-only sample of real originals; JPEG/WebP outputs stay on local disk.
// Never updates Supabase, uploads variants, or enables application flags.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { mkdir, mkdtemp, writeFile, open } = require('node:fs/promises');
const { tmpdir, cpus } = require('node:os');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const maxBytes = 20 * 1024 * 1024;
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
function percentile(values, fraction) {
    const ordered = [...values].sort((a, b) => a - b);
    return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))];
}
function stats(values) {
    return { mean: mean(values), median: percentile(values, 0.5), p90: percentile(values, 0.9),
        min: Math.min(...values), max: Math.max(...values) };
}
function meanInterval(values) {
    const average = mean(values);
    const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
    const margin = 1.96 * Math.sqrt(variance / values.length);
    return [Math.max(0, average - margin), average + margin];
}
function counts(values) {
    const result = {};
    for (const value of values) result[value ?? 'UNLABELLED'] = (result[value ?? 'UNLABELLED'] ?? 0) + 1;
    return result;
}
async function download(url, file, origin) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password) throw new Error('source_origin');
    const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok || Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel(); throw new Error(`source_http_${response.status}`);
    }
    const handle = await open(file, 'wx', 0o600);
    let bytes = 0;
    try {
        for await (const chunk of response.body) {
            bytes += chunk.length;
            if (bytes > maxBytes) throw new Error('source_too_large');
            await handle.writeFile(chunk);
        }
    } finally { await handle.close(); }
    if (!bytes) throw new Error('source_empty');
    return bytes;
}

async function main() {
    const size = Number(process.argv[2] ?? 80);
    if (!Number.isInteger(size) || size < 10 || size > 200) throw new Error('invalid_sample_size');
    const startedAt = new Date().toISOString();
    const directory = await mkdtemp(path.join(tmpdir(), 'warehouse-jpeg-benchmark-'));
    const website = process.env.IMAGE_PIPELINE_WEBSITE_ROOT ?? path.resolve(__dirname, '../../../website_combined/WareOnGo-Website-Backend');
    const { convertImageFile } = await import(pathToFileURL(path.join(website, 'services/webpImageProcess.js')));
    const origin = new URL(process.env.R2_PUBLIC_URL).origin;
    const rows = await prisma.$queryRawUnsafe(`WITH refs AS (
      SELECT DISTINCT unnest(public.wareongo_image_urls(media::jsonb, photos)) AS url FROM "Warehouse"
    ) SELECT l.id, r.url AS "imageUrl", l.classification::text AS classification,
      l."webpBytes"::text AS "webpBytes" FROM refs r LEFT JOIN labeled_warehouse_images l ON l."imageUrl" = r.url
      ORDER BY md5(r.url || 'jpeg-benchmark-2026-09-24')`);
    const selected = rows.slice(0, size);
    const dbRtt = [];
    for (let i = 0; i < 5; i++) {
        const start = performance.now(); await prisma.$queryRawUnsafe('SELECT 1'); dbRtt.push(performance.now() - start);
    }
    await prisma.$disconnect();
    console.log(JSON.stringify({ phase: 'sample', totalImages: rows.length, sample: selected.length,
        populationClasses: counts(rows.map(row => row.classification)), classes: counts(selected.map(row => row.classification)) }));
    const results = [], failures = [];
    let next = 0, lastProgress = 0;
    const start = performance.now();
    await Promise.all(Array.from({ length: 3 }, async () => {
        while (next < selected.length) {
            const row = selected[next++];
            const key = `${row.id ?? 'unlabelled'}-${createHash('sha256').update(row.imageUrl).digest('hex').slice(0, 12)}`;
            const input = path.join(directory, `${key}.original`);
            try {
                const beforeDownload = performance.now();
                const originalBytes = await download(row.imageUrl, input, origin);
                const downloadMs = performance.now() - beforeDownload;
                const queuedAt = performance.now();
                const output = await convertImageFile(input, path.join(directory, key), { width: 1280, quality: 75 },
                    new AbortController().signal, { workerPath: path.join(__dirname, 'lib/jpegBenchmarkWorker.cjs'), timeoutMs: 60000 });
                results.push({ imageId: row.id, classification: row.classification,
                    originalBytes, storedWebpBytes: row.webpBytes ? Number(row.webpBytes) : null,
                    downloadMs, queuedWorkerMs: performance.now() - queuedAt,
                    original: output.original, variants: output.variants, workerPeakRssMiB: output.peakRssMiB });
            } catch (error) {
                failures.push({ imageId: row.id, reason: /^source_[a-z_0-9]+$/.test(error.message) ? error.message : 'benchmark_failed', code: error.code });
            }
            if (performance.now() - lastProgress > 15000) {
                lastProgress = performance.now();
                console.log(JSON.stringify({ phase: 'benchmark', done: results.length, failed: failures.length, sample: selected.length }));
            }
        }
    }));
    if (!results.length) throw new Error('no_benchmark_results');
    const summary = { startedAt, finishedAt: new Date().toISOString(), readOnly: true,
        sampleMethod: 'Uniform sample from all distinct currently referenced originals, ordered by a fixed salted URL hash.',
        sampleRequested: size, sampleCompleted: results.length, totalImages: rows.length,
        classificationCounts: counts(rows.map(row => row.classification)), sampledClassifications: counts(results.map(row => row.classification)),
        cpu: cpus()[0]?.model, sharpVersion: require('sharp').versions.sharp,
        localSeconds: (performance.now() - start) / 1000,
        originalBytes: stats(results.map(row => row.originalBytes)), originalFormats: counts(results.map(row => row.original.format)),
        downloadMs: stats(results.map(row => row.downloadMs)), dbRoundTripMs: stats(dbRtt),
        currentStoredWebpBytes: rows.reduce((sum, row) => sum + Number(row.webpBytes ?? 0), 0),
        currentStoredWebpCount: rows.filter(row => Number(row.webpBytes) > 0).length,
        variants: results[0].variants.map(preset => {
            const variants = results.map(row => row.variants.find(result => result.name === preset.name));
            const bytes = variants.map(variant => variant.bytes);
            const timing = variants.map(variant => variant.encodeMs);
            return { name: preset.name, width: preset.width, quality: preset.quality,
                bytes: stats(bytes), encodeMs: stats(timing),
                estimatedTotalGB: mean(bytes) * rows.length / 1e9,
                approximate95PercentSamplingIntervalGB: meanInterval(bytes).map(value => value * rows.length / 1e9),
                estimatedSingleCoreEncodeMinutes: mean(timing) * rows.length / 60000,
                byteRatioToOriginal: mean(bytes) / mean(results.map(row => row.originalBytes)) };
        }),
        localArtifacts: directory, failures, results };
    const reportsDirectory = path.resolve(__dirname, '../tools/image-pipeline');
    await mkdir(reportsDirectory, { recursive: true });
    const reportPath = path.join(reportsDirectory, `${startedAt.replace(/[:.]/g, '-')}-jpeg-benchmark.json`);
    await writeFile(reportPath, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
    const { results: _results, ...log } = summary;
    console.log(JSON.stringify({ ...log, reportPath }));
}
main().catch(error => { console.error('JPEG benchmark failed', { name: error.name, code: error.code }); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
