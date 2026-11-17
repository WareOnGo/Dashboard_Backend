// Local size comparison through the real V3 generator. Uses cached real images
// and synthetic property details; no database or cloud writes. --overview-map
// fetches one real Mapbox image; --overview-map-file reuses a local copy.
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const axios = require('axios');
const JSZip = require('jszip');
const { normalizeImageBuffer } = require('../src/ppt/utils/image');
const { makeWarehouses, defaultCustomDetails } = require('../tools/ppt-preview/lib/fixtures');
const { createPptBufferV3 } = require('../src/ppt/services/pptServiceV3');
const { fetchOverviewMap } = require('../src/ppt/slides/v3/mapSlideV3');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stats = values => ({ mean: values.reduce((a, b) => a + b, 0) / values.length,
    min: Math.min(...values), max: Math.max(...values) });

async function main() {
    const mapFile = process.argv.find(arg => arg.startsWith('--overview-map-file='))?.split('=').slice(1).join('=');
    const withOverviewMap = process.argv.includes('--overview-map') || !!mapFile;
    const sourceReport = path.resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) || path.join(__dirname,
        '../tools/image-pipeline/2026-09-24T08-07-55-870Z-jpeg-benchmark.json'));
    const benchmark = JSON.parse(await fs.readFile(sourceReport, 'utf8'));
    const files = await fs.readdir(benchmark.localArtifacts);
    const startedAt = new Date().toISOString();
    const directory = path.resolve(__dirname, `../tools/ppt-preview/out/size-${startedAt.replace(/[:.]/g, '-')}`);
    await fs.mkdir(directory, { recursive: true });
    const urls = new Map(), imageHashes = new Map(), photos = [], documents = [];
    const variants = ['original', 'jpeg-1920-q82', 'jpeg-1280-q80'];
    for (const row of benchmark.results) {
        const record = { imageId: row.imageId, classification: row.classification, variants: {} };
        for (const variant of variants) {
            const suffix = variant === 'original' ? '.original' : `-${variant}.jpg`;
            const file = files.find(file => file.startsWith(`${row.imageId}-`) && file.endsWith(suffix));
            assert.ok(file, `Missing cached image ${row.imageId} ${variant}`);
            const format = variant === 'original' ? row.original.format : 'jpeg';
            const url = `https://ppt-size-benchmark.invalid/${variant}/${row.imageId}.${format === 'jpeg' ? 'jpg' : format}`;
            const body = await fs.readFile(path.join(benchmark.localArtifacts, file));
            const normalized = await normalizeImageBuffer(body, url);
            const embedded = Buffer.from(normalized.data.split(',')[1], 'base64');
            const digest = hash(embedded);
            urls.set(url, body);
            imageHashes.set(digest, { imageId: row.imageId,
                category: row.classification === 'DOCUMENT' ? 'document' : 'photo' });
            record.variants[variant] = { url, bytes: embedded.length, digest };
        }
        if (row.classification === 'INDOOR' || row.classification === 'OUTDOOR') photos.push(record);
        else if (row.classification === 'DOCUMENT') documents.push(record);
    }
    const random = [...photos].sort((a, b) => hash(String(a.imageId) + '-ppt-size').localeCompare(hash(String(b.imageId) + '-ppt-size')));
    const largest = [...photos].sort((a, b) => b.variants.original.bytes - a.variants.original.bytes);
    const largestJpeg = [...photos].sort((a, b) => b.variants['jpeg-1920-q82'].bytes - a.variants['jpeg-1920-q82'].bytes);
    const largestDocument = [...documents].sort((a, b) => b.variants.original.bytes - a.variants.original.bytes)[0];
    const scenarios = [
        { name: 'four_photos_each', perOption: 4, pool: random },
        { name: 'six_photos_each', perOption: 6, pool: random },
        { name: 'ten_photos_each', perOption: 10, pool: random },
        { name: 'twelve_photos_each', perOption: 12, pool: random },
        { name: 'six_largest_originals_each', perOption: 6, pool: largest },
        { name: 'twelve_largest_jpegs_each', perOption: 12, pool: largestJpeg },
        // An explicit stress case: repeat the largest sampled document as a
        // stand-in for five equally large drawings. Its original stays intact.
        { name: 'twelve_photos_and_large_drawing_each', perOption: 12, pool: random, drawing: largestDocument },
    ];
    const results = [];
    const makeRows = () => {
        const rows = makeWarehouses({ imageBase: 'https://ppt-size-benchmark.invalid', count: 5 });
        // One metropolitan area, as a normal five-option comparison uses.
        if (withOverviewMap) rows.forEach((row, index) => {
            row.city = 'Bengaluru'; row.state = 'Karnataka';
            row.WarehouseData.latitude = 12.97 + index * 0.027;
            row.WarehouseData.longitude = 77.59 + index * 0.035;
        });
        return rows;
    };
    let overviewBytes = null;
    if (withOverviewMap) {
        if (mapFile) {
            overviewBytes = await fs.readFile(path.resolve(mapFile));
            // Lets the unchanged generator construct its map request, which the
            // local HTTP adapter below answers without any external request.
            process.env.MAPBOX_ACCESS_TOKEN = 'local-benchmark';
        } else {
            require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
            const overview = await fetchOverviewMap(makeRows(), { mapsLocation: true });
            if (!overview) throw new Error('Overview map unavailable for measurement');
            overviewBytes = Buffer.from(overview.dataUri.split(',')[1], 'base64');
        }
        await fs.writeFile(path.join(directory, 'overview-map.png'), overviewBytes);
        imageHashes.set(hash(overviewBytes), { category: 'map' });
    }
    const originalGet = axios.get;
    axios.get = async url => {
        if (overviewBytes && url.startsWith('https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/')) {
            return { data: overviewBytes, status: 200, headers: {} };
        }
        const body = urls.get(url);
        if (!body) throw new Error('benchmark_external_http_blocked');
        return { data: body, status: 200, headers: {} };
    };
    try {
        for (const scenario of scenarios) {
            assert.ok(scenario.pool.length >= 5 * scenario.perOption);
            for (const variant of variants) {
                const warehouses = makeRows();
                const selected = {}, expectedPhotos = new Set();
                warehouses.forEach((warehouse, i) => {
                    const chosen = scenario.pool.slice(i * scenario.perOption, (i + 1) * scenario.perOption);
                    for (const photo of chosen) expectedPhotos.add(photo.variants[variant].digest);
                    const photoUrls = chosen.map(photo => photo.variants[variant].url);
                    selected[warehouse.id] = { photos: photoUrls,
                        cad: scenario.drawing ? [scenario.drawing.variants.original.url] : [] };
                    warehouse.photos = photoUrls.join(',');
                    warehouse.media = { images: photoUrls, videos: [], docs: [] };
                });
                const began = performance.now();
                const buffer = await createPptBufferV3(warehouses, selected, defaultCustomDetails({
                    clientName: 'Size benchmark — synthetic property details',
                    mapsLocation: withOverviewMap, proximitySlide: false, pocSlide: true,
                }));
                const generatedMs = performance.now() - began;
                const zip = await JSZip.loadAsync(buffer);
                const names = Object.keys(zip.files);
                const media = [], uniqueHashes = new Map(), actualPhotos = new Set();
                for (const name of names.filter(name => /^ppt\/media\/[^/]+$/.test(name))) {
                    const entry = zip.file(name), bytes = await entry.async('nodebuffer');
                    const digest = hash(bytes), source = imageHashes.get(digest);
                    const category = source?.category ?? 'branding';
                    if (category === 'photo') actualPhotos.add(digest);
                    uniqueHashes.set(digest, bytes.length);
                    media.push({ name, bytes: bytes.length, compressedBytes: entry._data.compressedSize,
                        imageId: source?.imageId ?? null, category, digest });
                }
                assert.deepEqual(actualPhotos, expectedPhotos, 'All selected photographs must actually be embedded');
                const photoEntries = media.filter(entry => entry.category === 'photo');
                assert.equal(photoEntries.length, 5 * (scenario.perOption + 1), 'V3 photo slides plus five specification strips');
                const photoBytes = photoEntries.reduce((sum, entry) => sum + entry.compressedBytes, 0);
                const documentEntries = media.filter(entry => entry.category === 'document');
                assert.equal(documentEntries.length, scenario.drawing ? 5 : 0);
                const documentBytes = documentEntries.reduce((sum, entry) => sum + entry.compressedBytes, 0);
                const mapEntries = media.filter(entry => entry.category === 'map');
                assert.equal(mapEntries.length, withOverviewMap ? 1 : 0);
                const keepArtifact = scenario.name === 'six_photos_each'
                    || (scenario.name === 'twelve_photos_each' && variant === 'jpeg-1920-q82');
                const result = { scenario: scenario.name, variant, options: 5,
                    selectedPhotographs: scenario.perOption * 5, embeddedPhotoCopies: photoEntries.length,
                    documentSlides: documentEntries.length, bytes: buffer.length, MB: buffer.length / 1e6,
                    MiB: buffer.length / 1024 ** 2, below25MB: buffer.length < 25000000,
                    slides: names.filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length,
                    photoBytes, documentBytes, overviewMapBytes: overviewBytes?.length ?? 0,
                    otherBytes: buffer.length - photoBytes - documentBytes,
                    repeatedMediaBytes: media.reduce((sum, entry) => sum + entry.bytes, 0) - [...uniqueHashes.values()].reduce((a, b) => a + b, 0),
                    generatedMs, mediaCount: media.length,
                    file: keepArtifact ? path.join(directory, `${scenario.name}-${variant}.pptx`) : null };
                if (result.file) await fs.writeFile(result.file, buffer);
                results.push(result);
                console.log(JSON.stringify(result));
            }
        }
    } finally { axios.get = originalGet; }
    const report = { startedAt, finishedAt: new Date().toISOString(), sourceBenchmark: sourceReport,
        method: 'Real, unchanged V3 generator, real cached photographs, synthetic warehouse fields. HTTP responses supplied from local cached bytes. Drawing stress case repeats the largest sampled document five times.',
        maps: withOverviewMap ? 'One real overview map of five synthetic Bengaluru option locations, downloaded once and reused. Optional proximity/client-routing maps excluded.' : 'Maps excluded.',
        overviewMapBytes: overviewBytes?.length ?? 0,
        unit: 'MB = 1,000,000 bytes; 25 MB limit tested conservatively.',
        sourcePhotos: photos.length,
        embeddedPhotographBytes: Object.fromEntries(variants.map(variant => [variant, stats(photos.map(photo => photo.variants[variant].bytes))])),
        largeDrawingBytes: largestDocument?.variants.original.bytes, results, remoteWrites: false };
    const reportPath = path.resolve(__dirname, `../tools/image-pipeline/${startedAt.replace(/[:.]/g, '-')}-ppt-v3-size.json`);
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ reportPath, artifactDirectory: directory, decks: results.length }));
}
main().catch(error => { console.error('PPT size benchmark failed', { name: error.name, message: error.message }); process.exitCode = 1; });
