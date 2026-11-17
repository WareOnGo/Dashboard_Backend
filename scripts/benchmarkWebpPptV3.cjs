// Local benchmark of existing R2 WebPs. --fetch performs SELECTs and image GETs
// only. Generated decks, image cache and reports stay under the ignored out/.
// App modules are unchanged; the image-loader substitution exists only here.
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const os = require('node:os');
const axios = require('axios');
const sharp = require('sharp');
const JSZip = require('jszip');
const imageUtils = require('../src/ppt/utils/image');
const { makeWarehouses, defaultCustomDetails } = require('../tools/ppt-preview/lib/fixtures');

const root = path.resolve(__dirname, '..');
const sourceReportPath = path.join(root, 'tools/image-pipeline/2026-09-24T08-07-55-870Z-jpeg-benchmark.json');
const cacheDirectory = path.join(root, 'tools/ppt-preview/out/webp-source-cache-2026-09-24');
const sourceManifestPath = path.join(cacheDirectory, 'manifest.json');
const mapPath = path.join(root, 'tools/ppt-preview/out/size-2026-09-24T09-16-09-850Z/overview-map.png');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stats = numbers => {
    const ordered = [...numbers].sort((a, b) => a - b);
    return { min: ordered[0], median: ordered[Math.floor(ordered.length / 2)],
        mean: numbers.reduce((sum, n) => sum + n, 0) / numbers.length, max: ordered.at(-1) };
};
const serializable = value => JSON.stringify(value, null, 2) + '\n';

async function fetchSources(sourceReport) {
    require('dotenv').config({ path: path.join(root, '.env'), quiet: true });
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    const ids = sourceReport.results.map(row => row.imageId).filter(Number.isInteger);
    let rows;
    const dbTimes = [];
    try {
        for (let repeat = 0; repeat < 4; repeat += 1) {
            const started = performance.now();
            rows = await prisma.$queryRawUnsafe(`SELECT id, "imageUrl", "webpUrl", "webpStatus",
                "webpBytes"::text AS "webpBytes" FROM labeled_warehouse_images
                WHERE id IN (SELECT value::int FROM jsonb_array_elements_text($1::jsonb))`, JSON.stringify(ids));
            dbTimes.push(performance.now() - started);
        }
    } finally { await prisma.$disconnect(); }
    assert.equal(rows.length, ids.length, 'Keep the original sample; do not silently drop missing rows');
    const byId = new Map(rows.map(row => [row.id, row]));
    const allowedOrigin = new URL(process.env.R2_PUBLIC_URL).origin;
    const results = [], failures = [];
    let next = 0, lastProgress = performance.now();
    await fs.mkdir(cacheDirectory, { recursive: true });
    const startedAt = new Date().toISOString();
    const started = performance.now();
    async function download(url, file) {
        assert.equal(new URL(url).origin, allowedOrigin, 'Unexpected source origin');
        const start = performance.now();
        const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`http_${response.status}`); }
        const chunks = [];
        let count = 0;
        for await (const chunk of response.body) {
            count += chunk.length;
            if (count > 20 * 1024 * 1024) throw new Error('image_too_large');
            chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);
        const downloadMs = performance.now() - start;
        const metadata = await sharp(body, { limitInputPixels: 16000000 }).metadata();
        assert.ok(metadata.width > 0 && metadata.height > 0);
        await fs.writeFile(file, body, { mode: 0o600 });
        return { bytes: count, downloadMs, format: metadata.format,
            width: metadata.width, height: metadata.height, orientation: metadata.orientation || 1,
            digest: sha(body), file };
    }
    await Promise.all(Array.from({ length: 3 }, async () => {
        while (next < sourceReport.results.length) {
            const index = next++;
            const sample = sourceReport.results[index];
            const row = byId.get(sample.imageId);
            try {
                const result = { imageId: row.id, classification: sample.classification, webpStatus: row.webpStatus };
                // Alternate order to avoid systematically warming connections for WebP.
                const variants = index % 2 ? ['webp', 'original'] : ['original', 'webp'];
                for (const variant of variants) {
                    if (variant === 'webp' && (row.webpStatus !== 'READY' || !row.webpUrl)) continue;
                    result[variant] = await download(variant === 'webp' ? row.webpUrl : row.imageUrl,
                        path.join(cacheDirectory, `${row.id}.${variant}`));
                    if (variant === 'webp') {
                        assert.equal(result.webp.format, 'webp');
                        if (row.webpBytes) assert.equal(result.webp.bytes, Number(row.webpBytes));
                    }
                }
                results.push(result);
            } catch (error) {
                failures.push({ imageId: sample.imageId, reason: error.code || 'download_or_validation_failed' });
            }
            if (performance.now() - lastProgress > 10000) {
                lastProgress = performance.now();
                console.log(JSON.stringify({ phase: 'download', completed: results.length, failed: failures.length, total: sourceReport.results.length }));
            }
        }
    }));
    const manifest = { startedAt, finishedAt: new Date().toISOString(), sourceReportPath,
        sourceSampleMethod: sourceReport.sampleMethod, remoteWrites: false,
        downloadedMs: performance.now() - started, concurrency: 3,
        dbFirstLookupMs: dbTimes[0], dbWarmLookupMs: stats(dbTimes.slice(1)),
        results, failures };
    await fs.writeFile(sourceManifestPath, serializable(manifest), { mode: 0o600 });
    assert.equal(failures.length, 0, 'Source download failures must be resolved before measuring');
    return manifest;
}

async function main() {
    const sourceReport = JSON.parse(await fs.readFile(sourceReportPath, 'utf8'));
    const manifest = process.argv.includes('--fetch') ? await fetchSources(sourceReport)
        : JSON.parse(await fs.readFile(sourceManifestPath, 'utf8'));
    assert.equal(manifest.failures.length, 0);
    assert.equal(manifest.results.length, sourceReport.sampleCompleted);
    const startedAt = new Date().toISOString();
    const directory = path.join(root, 'tools/ppt-preview/out', `webp-size-${startedAt.replace(/[:.]/g, '-')}`);
    await fs.mkdir(directory, { recursive: true });
    const bodies = new Map(), digestSources = new Map(), photos = [], drawings = [];
    for (const row of manifest.results) {
        const record = { imageId: row.imageId, variants: {} };
        for (const variant of ['original', 'webp']) {
            const source = variant === 'webp' ? row.webp || row.original : row.original;
            const ext = source.format === 'jpeg' ? 'jpg' : source.format;
            const url = `https://ppt-webp-benchmark.invalid/${variant}/${row.imageId}.${ext}`;
            const body = await fs.readFile(source.file);
            assert.equal(sha(body), source.digest);
            bodies.set(url, body);
            const normalized = variant === 'webp' && row.webp
                ? { data: `data:image/webp;base64,${body.toString('base64')}`, dims: imageUtils.readImageDimensions(body) }
                : await imageUtils.normalizeImageBuffer(body, url);
            const embedded = Buffer.from(normalized.data.split(',')[1], 'base64');
            const digest = sha(embedded);
            const category = row.classification === 'DOCUMENT' ? 'drawing' : 'photo';
            digestSources.set(digest, { imageId: row.imageId, category });
            record.variants[variant] = { url, digest, bytes: embedded.length,
                webpUsed: variant === 'webp' && !!row.webp, downloadMs: source.downloadMs };
        }
        if (['INDOOR', 'OUTDOOR'].includes(row.classification)) photos.push(record);
        else if (row.classification === 'DOCUMENT') drawings.push(record);
    }
    const map = await fs.readFile(mapPath);
    digestSources.set(sha(map), { category: 'map' });
    process.env.MAPBOX_ACCESS_TOKEN = 'local-benchmark';
    const oldGet = axios.get, oldFetch = imageUtils.fetchImage;
    axios.get = async url => {
        if (url.startsWith('https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/')) return { data: map };
        throw new Error('benchmark_external_http_blocked');
    };
    let activeTimings;
    imageUtils.fetchImage = async url => {
        const body = bodies.get(url);
        if (!body) throw new Error('benchmark_external_http_blocked');
        const start = performance.now();
        let normalized;
        if (body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP') {
            // Correct MIME only in the benchmark. No decoding/re-encoding of WebP.
            normalized = { data: `data:image/webp;base64,${body.toString('base64')}`,
                dims: imageUtils.readImageDimensions(body) };
        } else normalized = await imageUtils.normalizeImageBuffer(body, url);
        activeTimings.push(performance.now() - start);
        return normalized;
    };
    // Slides destructure fetchImage on import, so require after local substitution.
    const { createPptBufferV3 } = require('../src/ppt/services/pptServiceV3');
    const random = [...photos].sort((a, b) => sha(`${a.imageId}-ppt-size`).localeCompare(sha(`${b.imageId}-ppt-size`)));
    const largestOriginal = [...photos].sort((a, b) => b.variants.original.bytes - a.variants.original.bytes);
    const largestWebp = [...photos].sort((a, b) => b.variants.webp.bytes - a.variants.webp.bytes);
    const largeDrawing = [...drawings].sort((a, b) => b.variants.original.bytes - a.variants.original.bytes)[0];
    const scenarios = [
        ...[4, 6, 10, 12].map(n => ({ name: `${n}_photos_each`, perOption: n, pool: random })),
        { name: '6_largest_originals_each', perOption: 6, pool: largestOriginal },
        { name: '12_largest_webps_each', perOption: 12, pool: largestWebp },
        { name: '12_photos_and_large_drawing_each', perOption: 12, pool: random, drawing: largeDrawing },
        { name: '12_photos_and_original_drawing_fallback_each', perOption: 12, pool: random,
            drawing: largeDrawing, originalDrawing: true },
    ];
    function deckInput(scenario, variant) {
        assert.ok(scenario.pool.length >= 5 * scenario.perOption);
        const warehouses = makeWarehouses({ count: 5, imageBase: 'https://ppt-webp-benchmark.invalid' });
        const selected = {}, expected = new Set();
        warehouses.forEach((warehouse, i) => {
            warehouse.city = 'Bengaluru'; warehouse.state = 'Karnataka';
            warehouse.WarehouseData.latitude = 12.97 + i * 0.027;
            warehouse.WarehouseData.longitude = 77.59 + i * 0.035;
            const chosen = scenario.pool.slice(i * scenario.perOption, (i + 1) * scenario.perOption);
            chosen.forEach(photo => expected.add(photo.variants[variant].digest));
            selected[warehouse.id] = { photos: chosen.map(photo => photo.variants[variant].url),
                cad: scenario.drawing ? [scenario.drawing.variants[scenario.originalDrawing ? 'original' : variant].url] : [] };
            warehouse.photos = selected[warehouse.id].photos.join(',');
            warehouse.media = { images: selected[warehouse.id].photos, videos: [], docs: [] };
        });
        return { warehouses, selected, expected };
    }
    async function generate(scenario, variant) {
        const { warehouses, selected, expected } = deckInput(scenario, variant);
        activeTimings = [];
        const start = performance.now();
        const buffer = await createPptBufferV3(warehouses, selected, defaultCustomDetails({
            clientName: 'WebP benchmark — synthetic property details', mapsLocation: true,
            proximitySlide: false, pocSlide: true,
        }));
        return { buffer, expected, generatedMs: performance.now() - start,
            imagePreparationMs: activeTimings.reduce((sum, ms) => sum + ms, 0) };
    }
    const results = [];
    try {
        // Warm both paths, then alternate run order across five measured repeats.
        for (const variant of ['original', 'webp']) await generate(scenarios[0], variant);
        for (const scenario of scenarios) {
            const runs = { original: [], webp: [] };
            const last = {};
            for (let repeat = 0; repeat < 5; repeat += 1) {
                for (const variant of repeat % 2 ? ['webp', 'original'] : ['original', 'webp']) {
                    const output = await generate(scenario, variant);
                    runs[variant].push({ generatedMs: output.generatedMs, imagePreparationMs: output.imagePreparationMs });
                    last[variant] = output;
                }
            }
            for (const variant of ['original', 'webp']) {
                const { buffer, expected } = last[variant];
                const zip = await JSZip.loadAsync(buffer);
                const contentTypes = await zip.file('[Content_Types].xml').async('string');
                const media = [], actualPhotos = new Set();
                for (const name of Object.keys(zip.files).filter(name => /^ppt\/media\/[^/]+$/.test(name))) {
                    const bytes = await zip.file(name).async('nodebuffer');
                    const source = digestSources.get(sha(bytes));
                    const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
                    if (webp) { assert.ok(name.endsWith('.webp')); assert.ok(contentTypes.includes('ContentType="image/webp"')); }
                    if (source?.category === 'photo') actualPhotos.add(sha(bytes));
                    media.push({ name, bytes: bytes.length, category: source?.category || 'branding', webp });
                }
                assert.deepEqual(actualPhotos, expected, 'Do not count missing photos as size savings');
                assert.equal(media.filter(row => row.category === 'photo').length, 5 * (scenario.perOption + 1));
                assert.equal(media.filter(row => row.category === 'drawing').length, scenario.drawing ? 5 : 0);
                assert.equal(media.filter(row => row.category === 'map').length, 1);
                const file = path.join(directory, `${scenario.name}-${variant}.pptx`);
                if (['6_photos_each', '12_photos_each', '12_photos_and_large_drawing_each'].includes(scenario.name)) {
                    await fs.writeFile(file, buffer);
                }
                const result = { scenario: scenario.name, variant, options: 5, photosPerOption: scenario.perOption,
                    selectedPhotos: 5 * scenario.perOption, embeddedPhotoCopies: 5 * (scenario.perOption + 1),
                    bytes: buffer.length, MB: buffer.length / 1e6, below25MB: buffer.length < 25000000,
                    slides: Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length,
                    webpMedia: media.filter(row => row.webp).length,
                    originalPhotoFallbackCopies: variant === 'webp' ? media.filter(row => row.category === 'photo' && !row.webp).length : 0,
                    originalDrawingFallbackCopies: variant === 'webp' ? media.filter(row => row.category === 'drawing' && !row.webp).length : 0,
                    generatedMs: stats(runs[variant].map(run => run.generatedMs)),
                    imagePreparationMs: stats(runs[variant].map(run => run.imagePreparationMs)),
                    runs: runs[variant], media,
                    file: ['6_photos_each', '12_photos_each', '12_photos_and_large_drawing_each'].includes(scenario.name) ? file : null };
                results.push(result);
                console.log(JSON.stringify({ scenario: result.scenario, variant, MB: result.MB,
                    medianAssemblyMs: result.generatedMs.median, medianImagePreparationMs: result.imagePreparationMs.median,
                    webpMedia: result.webpMedia }));
            }
        }
    } finally { axios.get = oldGet; imageUtils.fetchImage = oldFetch; }
    const report = { startedAt, finishedAt: new Date().toISOString(), remoteWrites: false,
        cpu: os.cpus()[0]?.model, nodeVersion: process.version, sourceManifestPath,
        method: 'Real V3 builder and actual stored originals/WebPs from the earlier 80-image sample; synthetic warehouse details. Existing 1.126 MB overview map reused. Fetch/MIME substitution only inside benchmark, no app changes. Five alternating timed repeats after warmup; bytes supplied from local memory, no network/DB in assembly timings.',
        limits: 'Not a random sample of full customer decks. Optional proximity/client-route maps excluded. Drawing stress repeats one large document as five drawings. PowerPoint open/save compatibility is not measured. Non-ready WebPs use their originals; inspect source coverage and per-result fallback counts. Image preparation durations sum loader calls, including async waits; they are not CPU time.',
        sourceCounts: { photos: photos.length, drawings: drawings.length, webpReady: manifest.results.filter(r => r.webp).length,
            total: manifest.results.length, rotatedOriginals: manifest.results.filter(r => r.original.orientation !== 1).length },
        sourceDownloadMs: Object.fromEntries(['original', 'webp'].map(variant => [variant,
            stats(manifest.results.filter(row => row[variant]).map(row => row[variant].downloadMs))])),
        sourceBytes: Object.fromEntries(['original', 'webp'].map(variant => [variant,
            manifest.results.reduce((sum, row) => sum + (row[variant]?.bytes || 0), 0)])),
        dbFirstLookupMs: manifest.dbFirstLookupMs, dbWarmLookupMs: manifest.dbWarmLookupMs,
        unit: 'MB = 1,000,000 bytes', repeats: 5, mapBytes: map.length,
        largeDrawing: { originalBytes: largeDrawing.variants.original.bytes, webpBytes: largeDrawing.variants.webp.bytes },
        results };
    const reportPath = path.join(directory, 'report.json');
    await fs.writeFile(reportPath, serializable(report), { mode: 0o600 });
    console.log(JSON.stringify({ reportPath, artifactDirectory: directory, results: results.length,
        sourceCounts: report.sourceCounts, dbWarmLookupMs: report.dbWarmLookupMs, sourceDownloadMs: report.sourceDownloadMs }));
}
main().catch(error => {
    console.error('WebP PPT benchmark failed', { name: error.name, code: error.code,
        message: /ENOENT|benchmark|source|sample|media|photos|download/i.test(error.message) ? error.message : 'See local setup or source availability' });
    process.exitCode = 1;
});
