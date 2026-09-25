// Compare real V3 exports using the exact same originals/selections and maps.
// Only SELECTs and map GETs; pilot image bytes are already verified and cached.
const fs = require('node:fs/promises');
const path = require('node:path');
const axios = require('axios');
const JSZip = require('jszip');
const { performance } = require('node:perf_hooks');
const { sha } = require('./lib/jpegPilot');
const { imageUrls } = require('../src/utils/imageContract.cjs');
const { normalizeImageBuffer } = require('../src/ppt/utils/image');
const { createPptBufferV3 } = require('../src/ppt/services/pptServiceV3');

async function compare(prisma, reportPath) {
    const pilot = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    if (!pilot.ids?.length || pilot.ids.length > 4 || pilot.failures.length) throw new Error('A complete bounded JPEG pilot is required');
    const rows = await prisma.warehouse.findMany({ where: { id: { in: pilot.ids } },
        include: { WarehouseData: true, WarehouseProximity: true } });
    const warehouses = pilot.ids.map(id => rows.find(row => row.id === id));
    if (warehouses.some(row => !row)) throw new Error('A pilot warehouse no longer exists');
    const byUrl = new Map(pilot.results.map(row => [row.originalUrl, row]));
    const cached = new Map();
    const output = path.join(path.dirname(reportPath), 'ppt');
    await fs.mkdir(output, { recursive: true, mode: 0o700 });

    // Repeat requests for the same map use identical bytes in both versions.
    const originalGet = axios.get;
    const maps = new Map();
    axios.get = (url, options) => {
        const parsed = new URL(url);
        if (parsed.hostname !== 'api.mapbox.com' || !parsed.pathname.includes('/static/')) {
            return Promise.reject(new Error('Unexpected network request during JPEG comparison'));
        }
        if (!maps.has(url)) maps.set(url, originalGet(url, options));
        return maps.get(url);
    };

    const scenarios = [
        ...warehouses.map(warehouse => ({ name: `warehouse-${warehouse.id}-all-photos`, warehouses: [warehouse] })),
        { name: 'four-options-six-photos-each', warehouses, limit: 6 },
        { name: 'four-options-all-photos', warehouses },
    ];
    const result = { pilot: reportPath, ids: pilot.ids, preset: pilot.preset, mapRequests: 0, comparisons: [] };
    try {
        for (const scenario of scenarios) {
            const selection = {};
            for (const warehouse of scenario.warehouses) {
                const urls = imageUrls(warehouse);
                if (urls.some(url => !byUrl.has(url))) throw new Error('Warehouse media changed after the JPEG trial');
                selection[warehouse.id] = {
                    photos: urls.filter(url => byUrl.get(url).classification !== 'DOCUMENT').slice(0, scenario.limit),
                    cad: urls.filter(url => byUrl.get(url).documentKind === 'LAYOUT'),
                };
            }
            const comparison = { name: scenario.name, ids: scenario.warehouses.map(row => row.id),
                photos: Object.values(selection).reduce((sum, entry) => sum + entry.photos.length, 0),
                layouts: Object.values(selection).reduce((sum, entry) => sum + entry.cad.length, 0) };
            for (const mode of ['original', 'jpeg']) {
                const expected = new Set();
                const imageLoader = async url => {
                    const row = byUrl.get(url);
                    if (!row) throw new Error('Image is outside the pilot');
                    const key = `${mode}:${url}`;
                    if (!cached.has(key)) cached.set(key, (async () => {
                        const data = await fs.readFile(mode === 'jpeg' ? row.jpegFile : row.originalFile);
                        const image = await normalizeImageBuffer(data, mode === 'jpeg' ? row.jpegUrl : url);
                        if (mode === 'jpeg' && !image.data.startsWith('data:image/jpeg;')) throw new Error('Expected JPEG bytes');
                        return image;
                    })());
                    const image = await cached.get(key);
                    expected.add(sha(Buffer.from(image.data.split(',')[1], 'base64')));
                    return image;
                };
                // Prepare the expected hashes even if a builder accidentally skips a photo.
                for (const entry of Object.values(selection)) {
                    for (const url of [...entry.photos, ...entry.cad]) await imageLoader(url);
                }
                const started = performance.now();
                const buffer = await createPptBufferV3(scenario.warehouses, selection,
                    { clientName: 'JPEG pilot', clientRequirement: `Warehouses ${comparison.ids.join(', ')}`,
                        mapsLocation: true, pocSlide: false, proximitySlide: false }, { imageLoader });
                const assemblyMs = performance.now() - started;
                const file = path.join(output, `${scenario.name}-${mode}.pptx`);
                await fs.writeFile(file, buffer, { mode: 0o600 });
                const zip = await JSZip.loadAsync(buffer);
                const media = await Promise.all(zip.file(/^ppt\/media\/[^/]+$/).map(entry => entry.async('nodebuffer')));
                const hashes = new Set(media.map(sha));
                if ([...expected].some(hash => !hashes.has(hash))) throw new Error('A selected image is absent from the PPT');
                if (mode === 'jpeg' && media.some(bytes => bytes.toString('ascii', 0, 4) === 'RIFF')) {
                    throw new Error('Unexpected WebP in JPEG PPT');
                }
                comparison[mode] = { file, bytes: buffer.length, MB: buffer.length / 1e6, assemblyMs,
                    slides: zip.file(/^ppt\/slides\/slide\d+\.xml$/).length, allSelectedImagesPresent: true };
            }
            if (comparison.original.slides !== comparison.jpeg.slides) throw new Error('Slide count changed');
            comparison.reductionPercent = 100 * (1 - comparison.jpeg.bytes / comparison.original.bytes);
            result.comparisons.push(comparison);
            console.log(JSON.stringify(comparison));
        }
        result.mapRequests = maps.size;
        await fs.writeFile(path.join(output, 'comparison.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
        return result;
    } finally { axios.get = originalGet; }
}

module.exports = { compare };
if (require.main === module) {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/compareJpegPilotPpts.js path/to/jpeg-pilot/report.json');
    require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    compare(prisma, path.resolve(process.argv[2]))
        .catch(error => { console.error('JPEG PPT comparison failed', { name: error.name, code: error.code, reason: error.message.split('\n')[0] }); process.exitCode = 1; })
        .finally(() => prisma.$disconnect());
}
