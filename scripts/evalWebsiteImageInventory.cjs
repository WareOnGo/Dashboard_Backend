// Read-only inventory for website-image approval evaluation. No R2/DB writes.
const fs = require('node:fs/promises');
const path = require('node:path');
const { imageUrls } = require('../src/utils/imageContract.cjs');

function quantiles(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return Object.fromEntries([0, .25, .5, .75, .9, .95, 1].map(q => [q, sorted[Math.floor((sorted.length - 1) * q)] ?? 0]));
}
function summarize(warehouses, images) {
    const byUrl = new Map(images.map(row => [row.imageUrl, row]));
    const data = warehouses.map(row => {
        const records = row.originalUrls.map(url => byUrl.get(url));
        const count = type => records.filter(image => image?.classification === type).length;
        return { id: row.id, total: records.length, indoor: count('INDOOR'), outdoor: count('OUTDOOR'),
            documents: count('DOCUMENT'), unknown: count('UNKNOWN'), unlabelled: records.filter(r => !r?.classification).length };
    });
    const photos = row => row.indoor + row.outdoor;
    const unique = new Set(warehouses.flatMap(row => row.originalUrls));
    return {
        warehouses: data.length, uniqueImages: unique.size,
        imageReferences: data.reduce((n, r) => n + r.total, 0),
        totalQuantiles: quantiles(data.map(r => r.total)), photoQuantiles: quantiles(data.map(photos)),
        photoBins: Object.fromEntries([[0,0],[1,3],[4,5],[6,7],[8,11],[12,19],[20,9999]].map(([a,b]) =>
            [`${a}-${b}`, data.filter(r => photos(r) >= a && photos(r) <= b).length])),
        thresholds: Object.fromEntries([4,6,8].map(n => [n, {
            enoughPhotos: data.filter(r => photos(r) >= n).length,
            equalSplitPossible: data.filter(r => r.indoor >= n/2 && r.outdoor >= n/2).length,
        }])),
        noImages: data.filter(r => r.total === 0).length,
        noScenePhotos: data.filter(r => photos(r) === 0).length,
        indoorOnly: data.filter(r => r.indoor > 0 && r.outdoor === 0).length,
        outdoorOnly: data.filter(r => r.outdoor > 0 && r.indoor === 0).length,
        withDocuments: data.filter(r => r.documents > 0).length,
        withUnknownOrUnlabelled: data.filter(r => r.unknown + r.unlabelled > 0).length,
        classification: Object.fromEntries(['INDOOR','OUTDOOR','DOCUMENT','UNKNOWN','UNLABELLED'].map(type =>
            [type, [...unique].filter(url => (byUrl.get(url)?.classification || 'UNLABELLED') === type).length])),
    };
}

async function inventory(prisma, output) {
    const snapshot = await prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        const warehouses = await tx.$queryRawUnsafe(`SELECT id, visibility, city, state, "warehouseType",
          media, photos FROM "Warehouse" ORDER BY id`);
        const images = await tx.$queryRawUnsafe(`SELECT id, "imageUrl", classification::text,
          "documentKind"::text, description, "webpUrl", "jpegUrl", "webpBytes"::text,
          "jpegBytes"::text FROM labeled_warehouse_images ORDER BY id`);
        return { warehouses: warehouses.map(({ media, photos, ...row }) => ({ ...row, originalUrls: imageUrls({media,photos}) })), images };
    }, { isolationLevel: 'RepeatableRead', timeout: 60000 });
    const visible = snapshot.warehouses.filter(row => row.visibility === true);
    const result = { at: new Date().toISOString(), readOnly: true,
        summary: { all: summarize(snapshot.warehouses, snapshot.images), public: summarize(visible, snapshot.images) }, ...snapshot };
    await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return { file: output, at: result.at, ...result.summary };
}

module.exports = { summarize, inventory };
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !args[0].startsWith('--output=')) throw new Error('Usage: evalWebsiteImageInventory.cjs --output=/tmp/path/inventory.json');
    require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    inventory(prisma, path.resolve(args[0].slice(9))).then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(error => { console.error({ name: error.name, code: error.code, message: error.message.split('\n').slice(-1)[0] }); process.exitCode = 1; })
        .finally(() => prisma.$disconnect());
}
