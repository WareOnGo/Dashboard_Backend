const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { PrismaClient } = require('@prisma/client');
const testDatabaseUrl = require('../helpers/testDatabaseUrl');
const { ImagePipelineRepository, registerWarehouseImages } = require('../../src/models/imagePipelineRepository.cjs');
const ImageLabelModel = require('../../src/models/imageLabelModel');
const ImageLabelService = require('../../src/services/imageLabelService');
const contract = require('../../src/utils/imageContract.cjs');
const { migrate } = require('../../scripts/migrateImagePipeline');

const databaseUrl = testDatabaseUrl(process.env.TEST_DATABASE_URL);
process.env.DATABASE_URL = databaseUrl;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const repository = new ImagePipelineRepository(prisma);
const site = process.env.IMAGE_PIPELINE_WEBSITE_ROOT || path.resolve(__dirname, '../../../../website_combined/WareOnGo-Website-Backend');
let webpModule;
const base = 'https://fixture.r2.dev';
const url = name => `${base}/${name}.jpg`;
const label = { classification: 'INDOOR', description: 'Preserved caption', model: 'fixture-model', confidence: 0.9 };
const webp = { storageBucket: 'fixture', originalObjectKey: 'a.jpg', webpUrl: `${base}/webp/a.webp`,
    webpObjectKey: 'webp/a.webp', webpBytes: 12, webpAt: new Date().toISOString(), webpVersion: null };
async function warehouse(id, images, extra = {}) {
    const media = extra.media === undefined ? { images, videos: [`${base}/movie.mp4`], docs: [`${base}/notes.pdf`] } : extra.media;
    await prisma.$executeRawUnsafe(`INSERT INTO "Warehouse" (id,media,photos,visibility) VALUES ($1,$2::jsonb,$3,$4)`,
        id, JSON.stringify(media), extra.photos ?? images.join(','), extra.visible ?? true);
}
async function rowFor(source) {
    return (await prisma.$queryRawUnsafe('SELECT * FROM labeled_warehouse_images WHERE "imageUrl" = $1', source))[0];
}
before(async () => { webpModule = await import(pathToFileURL(path.join(site, 'services/webpPipeline.js'))); });
beforeEach(async () => {
    // Guarded dedicated local test database; never falls back to DATABASE_URL.
    await prisma.$executeRawUnsafe('TRUNCATE "Warehouse", labeled_warehouse_images RESTART IDENTITY CASCADE');
});
after(() => prisma.$disconnect());

test('both real backend read paths return the same pairs; public list/detail still hide private stock', async () => {
    for (const [name, type] of Object.entries({ address: 'text', city: 'text', state: 'text', postalCode: 'text',
        totalSpaceSqft: 'int[]', clearHeightFt: 'text', compliances: 'text', otherSpecifications: 'text',
        ratePerSqft: 'text', warehouseType: 'text', zone: 'text', micromarket: 'text[]',
        status_updated_at: 'timestamp', createdAt: 'timestamp', numberOfDocks: 'text', flooringType: 'text' })) {
        await prisma.$executeRawUnsafe(`ALTER TABLE "Warehouse" ADD COLUMN IF NOT EXISTS "${name}" ${type}`);
    }
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "WarehouseData" (id serial PRIMARY KEY, "warehouseId" int UNIQUE,
      "fireNocAvailable" boolean, "fireSafetyMeasures" text, latitude float, longitude float)`);
    await warehouse(1, [url('a'), url('pending')]); await warehouse(2, [url('private')], { visible: false });
    await prisma.$executeRawUnsafe(`UPDATE "Warehouse" SET address = 'Fixture warehouse', city = 'Test City', state = 'Test State',
      compliances = '', "ratePerSqft" = '', zone = '', "warehouseType" = 'Industrial',
      "createdAt" = now(), status_updated_at = now(), "totalSpaceSqft" = ARRAY[1000]`);
    await repository.register();
    const [variant] = await repository.claim('webp', { limit: 1, warehouseId: 1 });
    await repository.complete('webp', variant, webp);
    const websitePrisma = (await import(pathToFileURL(path.join(site, 'models/prismaClient.js')))).default;
    const siteController = await import(pathToFileURL(path.join(site, 'controllers/warehouseController.js')));
    const redis = (await import(pathToFileURL(path.join(site, 'services/redisService.js')))).default;
    const cached = new Map();
    redis.get = async key => cached.get(key);
    redis.setEx = async (key, _ttl, value) => cached.set(key, value);
    const express = require('express');
    const WarehouseController = require('../../src/controllers/warehouseController');
    const dashboard = new WarehouseController({ getWarehouseById: id => prisma.warehouse.findUnique({
        where: { id }, select: { id: true, media: true, photos: true } }), }, null, null,
    new ImageLabelService(new ImageLabelModel(prisma), {}));
    const app = express();
    app.use((req, _res, next) => { req.audit = () => {}; next(); });
    app.get('/dashboard/:id', dashboard.getWarehouseById);
    app.get('/website/:id', siteController.getWarehouseById);
    app.get('/website', siteController.getWarehouses);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    try {
        const dash = await (await fetch(`${endpoint}/dashboard/1`)).json();
        const detail = await (await fetch(`${endpoint}/website/1`)).json();
        assert.deepEqual((dash.data ?? dash).images, detail.images);
        assert.equal(detail.images[1].displayUrl, url('pending'));
        assert.equal(detail.images[0].webpUrl, webp.webpUrl);
        assert.equal((await fetch(`${endpoint}/website/2`)).status, 404);
        const list = await (await fetch(`${endpoint}/website`)).json();
        assert.equal(list.pagination.totalItems, 1);
        assert.deepEqual(list.data[0].images, detail.images);
        assert.equal(Object.hasOwn(list.data[0], 'media'), false);
        assert.ok([...cached.keys()][0].startsWith('warehouses:v7-images:'));
    } finally {
        await new Promise(resolve => server.close(resolve));
        await websitePrisma.$disconnect();
    }
});

test('SQL and JS agree on serialized media, explicit removals, mixed legacy arrays and shared order', async () => {
    const fixtures = [
        { media: { images: [url('b'), url('a'), url('b')] }, photos: url('old') },
        { media: { images: [] }, photos: url('old') },
        { media: JSON.stringify({ images: [url('b')] }), photos: url('old') },
        { media: JSON.stringify(JSON.stringify({ images: [url('b')] })), photos: url('old') },
        { media: null, photos: JSON.stringify([`${base}/movie.mp4, ${url('a')}`, null, `${base}/note.pdf`, url('b')]) },
        { media: {}, photos: `${url('a')}?q=1, ${base}/folder/photo%20one.PNG` },
        { media: 'malformed', photos: 'https://res.cloudinary.com/demo/w_800,q_auto/a.jpg' },
        { media: { images: null }, photos: null },
    ];
    for (const fixture of fixtures) {
        const [result] = await prisma.$queryRawUnsafe('SELECT public.wareongo_image_urls($1::jsonb,$2) AS urls', JSON.stringify(fixture.media), fixture.photos);
        assert.deepEqual(result.urls, contract.imageUrls(fixture));
    }
});

test('registration is idempotent, keeps media intact, and shares one original across warehouses', async () => {
    await warehouse(1, [url('a'), url('b')]); await warehouse(2, [url('b'), url('a')]);
    const before = await prisma.$queryRawUnsafe('SELECT * FROM "Warehouse" ORDER BY id');
    assert.equal(await repository.register(1), 2);
    assert.equal(await repository.register(2), 0);
    const images = await repository.readImages(before);
    assert.deepEqual(images.get(2).map(image => image.originalUrl), [url('b'), url('a')]);
    assert.equal(images.get(1)[0].id, images.get(2)[1].id);
    assert.equal(images.get(1)[0].webpUrl, null);
    assert.deepEqual(await prisma.$queryRawUnsafe('SELECT * FROM "Warehouse" ORDER BY id'), before);
});

test('both backend registration hooks forward-fill without configuration and preserve warehouse media', async () => {
    const siteRegister = require(path.join(site, 'services/imagePipelineRepository.cjs')).registerWarehouseImages;
    await warehouse(1, [url('dashboard')]); await warehouse(2, [url('website')]);
    const before = await prisma.$queryRawUnsafe('SELECT * FROM "Warehouse" ORDER BY id');
    await registerWarehouseImages(prisma, 1);
    await siteRegister(prisma, 2);
    for (const source of [url('dashboard'), url('website')]) {
        const row = await rowFor(source);
        assert.equal(row.labelStatus, 'PENDING');
        assert.equal(row.webpStatus, 'PENDING');
        assert.equal(row.classification, null);
    }
    assert.deepEqual(await prisma.$queryRawUnsafe('SELECT * FROM "Warehouse" ORDER BY id'), before);
});

test('label and WebP workers can own one image independently and preserve each other’s results', async () => {
    await warehouse(1, [url('a')]); await repository.register();
    const [[scene], [variant]] = await Promise.all([repository.claim('label'), repository.claim('webp')]);
    assert.equal(scene.id, variant.id);
    assert.equal(await repository.complete('webp', variant, webp), 1);
    assert.equal(await repository.complete('label', scene, label), 1);
    await repository.register();
    const row = await rowFor(url('a'));
    assert.equal(row.description, label.description); assert.equal(row.webpUrl, webp.webpUrl);
    assert.equal(row.webpBytes, 12n); assert.equal(row.labelStatus, 'READY');
    assert.equal((await repository.claim('label')).length, 0);
    assert.equal((await repository.claim('webp')).length, 0);
    const read = await repository.readImages([{ id: 1, media: { images: [url('a')] } }]);
    assert.doesNotThrow(() => JSON.stringify([...read]));
    assert.equal(read.get(1)[0].webpUrl, webp.webpUrl);
    assert.equal(Object.hasOwn(read.get(1)[0], 'webpBytes'), false);
});

test('two workers cannot claim the same stage; expired workers cannot publish or clear a new lease', async () => {
    await warehouse(1, [url('a')]); await repository.register();
    const [one, two] = await Promise.all([repository.claim('label'), repository.claim('label')]);
    assert.equal(one.length + two.length, 1);
    const old = [...one, ...two][0];
    await prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images SET "labelLeaseUntil" = now() - interval '1 second'`);
    const [current] = await repository.claim('label');
    assert.notEqual(old.labelClaimToken, current.labelClaimToken);
    assert.equal(await repository.complete('label', old, label), 0);
    assert.equal(await repository.fail('label', old, 'old failure'), 0);
    assert.equal(await repository.complete('label', current, label), 1);
});

test('document retries do not repeat or lose a successful scene label', async () => {
    await warehouse(1, [url('plan')]); await repository.register();
    const [scene] = await repository.claim('label');
    await repository.complete('label', scene, { ...label, classification: 'DOCUMENT' });
    const [document] = await repository.claim('document');
    await repository.fail('document', document, 'temporary');
    assert.equal((await repository.claim('document')).length, 0);
    assert.equal((await repository.claim('label')).length, 0);
    assert.equal((await rowFor(url('plan'))).description, label.description);
    await prisma.$executeRawUnsafe('UPDATE labeled_warehouse_images SET "documentNextAttemptAt" = NULL');
    const [retry] = await repository.claim('document');
    await repository.complete('document', retry, { documentKind: 'LAYOUT' });
    const svc = new ImageLabelService(new ImageLabelModel(prisma), {});
    assert.equal((await svc.getForWarehouse(1)).labels[url('plan')].documentKind, 'LAYOUT');
    assert.equal((await svc.getForWarehouses([1])).warehouses['1'].images[0].documentKind, 'LAYOUT');
});

test('removed images are retained; a shared or legacy-only reference remains usable', async () => {
    await warehouse(1, [url('a')]); await warehouse(2, [], { media: null, photos: url('a') });
    await repository.register();
    const [scene] = await repository.claim('label'); await repository.complete('label', scene, label);
    const model = new ImageLabelModel(prisma);
    assert.equal(await model.countAll(), 1); // Shared images are counted once.
    await prisma.$executeRawUnsafe(`UPDATE "Warehouse" SET media = '{"images":[]}' WHERE id = 1`);
    await repository.reconcile();
    assert.equal((await rowFor(url('a'))).unreferencedAt, null);
    assert.equal((await repository.rowsForWarehouses([1])).length, 0);
    assert.equal((await repository.rowsForWarehouses([2])).length, 1);
    await prisma.$executeRawUnsafe('DELETE FROM "Warehouse" WHERE id = 2');
    assert.equal((await repository.reconcile()).retained, 1);
    assert.ok((await rowFor(url('a'))).unreferencedAt);
    assert.equal(await model.countAll(), 0); // Retained history is not active coverage.
    assert.equal((await repository.claim('label')).length, 0);
    await warehouse(3, [url('a')]); await repository.register(3);
    assert.equal((await rowFor(url('a'))).unreferencedAt, null);
});

test('a stale object inventory cannot reset a newly published WebP', async () => {
    await warehouse(1, [url('a')]); await repository.register();
    const repo = webpModule.webpPipelineRepository(prisma);
    const [variant] = await repository.claim('webp'); await repository.complete('webp', variant, webp);
    const stale = await repo.inventoryRows();
    await prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images SET "webpObjectKey" = 'webp/new-version.webp', "webpCheckedAt" = now()`);
    assert.equal(await repo.markMissing(stale), 0);
    assert.equal((await rowFor(url('a'))).webpStatus, 'READY');
});

test('compatibility label writes fill pending rows without overwriting WebP or existing labels', async () => {
    await warehouse(1, [url('a')]); await repository.register();
    const [variant] = await repository.claim('webp'); await repository.complete('webp', variant, webp);
    const model = new ImageLabelModel(prisma);
    assert.equal((await model.findUnlabelled(10)).length, 1);
    assert.equal(await model.createManyLabels([{ warehouseId: 1, imageUrl: url('a'), ...label }]), 1);
    assert.equal(await model.createManyLabels([{ warehouseId: 1, imageUrl: url('a'), ...label, description: 'overwrite' }]), 0);
    assert.equal((await rowFor(url('a'))).webpUrl, webp.webpUrl);
});

test('WebP checks reject JPEG output, and an interrupted final attempt stops retrying', async () => {
    await warehouse(1, [url('a')]); await repository.register();
    const [variant] = await repository.claim('webp');
    await assert.rejects(repository.complete('webp', variant, { ...webp, webpUrl: url('compressed-jpeg') }));
    await prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images SET "webpAttempts" = 5, "webpLeaseUntil" = now() - interval '1 second'`);
    assert.equal((await repository.claim('webp')).length, 0);
    assert.equal((await rowFor(url('a'))).webpStatus, 'FAILED');
});

test('WebP forward-fill reuses objects, handles hidden stock, repairs missing objects and projects legacy URLs', async () => {
    await warehouse(1, [url('a')]); await warehouse(2, [url('b')], { visible: false });
    const beforeMedia = await prisma.$queryRawUnsafe('SELECT id,media,photos FROM "Warehouse" ORDER BY id');
    const objects = new Map([['webp/a.webp', { bytes: 100, modifiedAt: new Date() }]]);
    const uploads = [];
    const store = { publicBase: base, bucket: 'fixture', version: 'sharp-w1280-q75-v1',
        existingKeys: async () => new Set(objects.keys()), objectMetadata: async key => objects.get(key),
        upload: async (source, target) => { uploads.push(source); objects.set(target.key, { bytes: 80, modifiedAt: new Date() }); return 80; } };
    const repo = webpModule.webpPipelineRepository(prisma);
    let clears = 0;
    const run = () => webpModule.compressWebpPipeline({ repository: repo, store, clearCache: async () => { clears++; } });
    const first = await run();
    assert.equal(first.reused, 1); assert.equal(first.uploaded, 1); assert.deepEqual(uploads, [url('b')]);
    assert.equal((await rowFor(url('a'))).webpVersion, null);
    assert.equal((await rowFor(url('b'))).webpStatus, 'READY');
    assert.equal((await run()).uploaded, 0);
    objects.delete('webp/a.webp');
    assert.equal((await run()).uploaded, 1);
    assert.deepEqual(uploads, [url('b'), url('a')]);
    assert.equal(clears, 2);
    assert.deepEqual(await prisma.$queryRawUnsafe('SELECT id,media,photos FROM "Warehouse" ORDER BY id'), beforeMedia);
    const photos = await prisma.$queryRawUnsafe('SELECT "photosWebp" FROM "Warehouse" WHERE id = 1');
    assert.equal(JSON.parse(photos[0].photosWebp)[0], (await rowFor(url('a'))).webpUrl);
});

test('legacy filename collisions use distinct WebPs and original fallback survives a failed conversion', async () => {
    await warehouse(1, [url('same'), `${base}/same.png`]);
    const uploads = [];
    const repo = webpModule.webpPipelineRepository(prisma);
    const store = { publicBase: base, bucket: 'fixture', version: 'sharp-w1280-q75-v1',
        existingKeys: async () => new Set(['webp/same.webp']), objectMetadata: async () => ({ bytes: 100 }),
        upload: async (source, target) => { uploads.push(target.key); if (source.endsWith('.png')) throw new Error('fixture'); return 80; } };
    const result = await webpModule.compressWebpPipeline({ repository: repo, store });
    assert.equal(result.uploaded, 1); assert.equal(result.failed, 1); assert.notEqual(uploads[0], uploads[1]);
    const read = await repo.readImages([{ id: 1, media: { images: [url('same'), `${base}/same.png`] } }]);
    assert.equal(read.get(1)[1].displayUrl, `${base}/same.png`);
    assert.equal((await repo.claim('webp')).length, 0); // Failed work is delayed.
});

test('legacy projection supports SQL-null media and rejects a concurrent photo edit', async () => {
    await warehouse(1, [url('a')]);
    await prisma.$executeRawUnsafe('UPDATE "Warehouse" SET media = NULL');
    await repository.register();
    const [variant] = await repository.claim('webp'); await repository.complete('webp', variant, webp);
    const repo = webpModule.webpPipelineRepository(prisma);
    assert.equal(await repo.projectLegacy(), 1);
    const [{ photosWebp }] = await prisma.$queryRawUnsafe('SELECT "photosWebp" FROM "Warehouse"');
    assert.deepEqual(JSON.parse(photosWebp), [webp.webpUrl]);
    await prisma.$executeRawUnsafe('UPDATE "Warehouse" SET "photosWebp" = NULL');
    const read = repo.readImages.bind(repo);
    repo.readImages = async rows => {
        await prisma.$executeRawUnsafe('UPDATE "Warehouse" SET photos = $1', url('new'));
        return read(rows);
    };
    assert.equal(await repo.projectLegacy(), 0);
    const [row] = await prisma.$queryRawUnsafe('SELECT photos, "photosWebp" FROM "Warehouse"');
    assert.equal(row.photos, url('new')); assert.equal(row.photosWebp, null);
});

test('migration copies backfilled WebP data while preserving all existing values and media', async () => {
    await warehouse(1, [url('a')]); await repository.register();
    await prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images SET "storageBucket" = 'fixture',
      "compressedImageUrl" = $1, "compressedObjectKey" = 'webp/a.webp', "compressedBytes" = 12,
      "compressionStatus" = 'READY', "compressionCheckedAt" = now()`, webp.webpUrl);
    // Simulate the pre-migration column set by dropping only newly added WebP
    // fields inside this isolated fixture database, never production.
    await prisma.$executeRawUnsafe(`ALTER TABLE labeled_warehouse_images DROP COLUMN "webpUrl" CASCADE,
      DROP COLUMN "webpObjectKey", DROP COLUMN "webpBytes", DROP COLUMN "webpAt", DROP COLUMN "webpStatus",
      DROP COLUMN "webpError", DROP COLUMN "webpCheckedAt", DROP COLUMN "webpVersion"`);
    const report = await migrate(prisma, true);
    await prisma.$disconnect(); // DDL changed SELECT * fixture result types in the prepared-statement cache.
    assert.equal(report.oldColumnsPreserved, true); assert.equal(report.mediaPreserved, true);
    assert.equal((await rowFor(url('a'))).webpUrl, webp.webpUrl);
    assert.equal((await rowFor(url('a'))).compressedImageUrl, webp.webpUrl);
    assert.equal((await migrate(prisma, true)).oldColumnsPreserved, true);
});
