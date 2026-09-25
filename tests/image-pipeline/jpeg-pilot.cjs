const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { PrismaClient } = require('@prisma/client');
const testDatabaseUrl = require('../helpers/testDatabaseUrl');
const { migrateJpeg } = require('../../scripts/migrateImageJpeg');
const { dropUnusedJpeg } = require('../../scripts/dropUnusedImageJpeg');
const { runPilot } = require('../../scripts/pilotJpegVariants');
const { JPEG_FIELDS, JPEG_VERSION, parsePilotArgs, compressJpeg, jpegTarget, publishJpeg } = require('../../scripts/lib/jpegPilot');
const prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl(process.env.TEST_DATABASE_URL) } } });
const original = 'https://fixture.r2.dev/original.png';
const read = () => prisma.$queryRawUnsafe(`SELECT to_jsonb(w) AS warehouse,to_jsonb(l) AS image
  FROM "Warehouse" w JOIN labeled_warehouse_images l ON l."warehouseId"=w.id`);
const nonJpeg = object => Object.fromEntries(Object.entries(object).filter(([key]) => !JPEG_FIELDS.includes(key)));

beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "Warehouse",labeled_warehouse_images RESTART IDENTITY CASCADE');
    await dropUnusedJpeg(prisma, true);
    await prisma.$executeRawUnsafe(`INSERT INTO "Warehouse" (id,media,photos,"photosWebp") VALUES
      (1,$1::jsonb,$2,'["https://fixture.r2.dev/original.webp"]')`,
    JSON.stringify({ images: [original], videos: ['video.mp4'], docs: ['notes.pdf'] }), original);
    await prisma.$executeRawUnsafe(`INSERT INTO labeled_warehouse_images
      ("warehouseId","imageUrl",classification,description,"webpUrl","webpBytes","webpStatus","storageBucket","webpObjectKey")
      VALUES (1,$1,'INDOOR','Keep the original caption','https://fixture.r2.dev/original.webp',123,'READY','fixture','original.webp')`, original);
});
after(async () => { await migrateJpeg(prisma, true); await prisma.$disconnect(); });

test('adds only the six fields, preserves old values, and can be reapplied after JPEG publication', async () => {
    const [before] = await read();
    assert.equal((await migrateJpeg(prisma)).mode, 'dry-run');
    assert.deepEqual(await read(), [before]);
    const report = await migrateJpeg(prisma, true);
    assert.equal(report.oldColumnsPreserved, true);
    assert.equal(report.mediaPreserved, true);
    const [added] = await read();
    assert.deepEqual(added.warehouse, before.warehouse);
    assert.deepEqual(nonJpeg(added.image), before.image);
    assert.deepEqual(Object.keys(added.image).filter(key => key.startsWith('jpeg')).sort(), [...JPEG_FIELDS].sort());
    await assert.rejects(prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images SET "jpegStatus"='READY'`));
    const result = await publishJpeg(prisma, { id: added.image.id, imageUrl: original, jpegUrl: null, jpegVersion: null },
        [1], { url: 'https://fixture.r2.dev/jpeg/result.jpg', bytes: 456 });
    assert.equal(result.nonJpegFieldsPreserved, true);
    const [published] = await read();
    assert.deepEqual(published.warehouse, before.warehouse);
    assert.deepEqual(nonJpeg(published.image), before.image);
    assert.equal(published.image.jpegStatus, 'READY');
    assert.equal(published.image.jpegVersion, JPEG_VERSION);
    await migrateJpeg(prisma, true);
    assert.deepEqual(await read(), [published]);
    await assert.rejects(dropUnusedJpeg(prisma, true), /Refusing to drop/);
});

test('publication refuses changed membership and concurrent JPEG results', async () => {
    await migrateJpeg(prisma, true);
    const [before] = await read();
    const row = { id: before.image.id, imageUrl: original, jpegUrl: null, jpegVersion: null };
    const output = { url: 'https://fixture.r2.dev/jpeg/result.jpg', bytes: 456 };
    await assert.rejects(publishJpeg(prisma, row, [2], output), /no_longer_referenced/);
    assert.deepEqual(await read(), [before]);
    await publishJpeg(prisma, row, [1], output);
    const [published] = await read();
    await assert.rejects(publishJpeg(prisma, row, [1], output), /changed_during_pilot/);
    assert.deepEqual(await read(), [published]);
});

test('pilot preview touches neither storage nor image values', async () => {
    await migrateJpeg(prisma, true);
    const before = await read();
    const report = await runPilot(prisma, { ids: [1], apply: false }, {
        s3: { send() { throw new Error('Storage must not be called'); } },
    });
    assert.equal(report.images, 1);
    assert.equal(report.fullBackfillStarted, false);
    assert.deepEqual(await read(), before);
});

test('CLI requires a bounded explicit selection and does not accept a global backfill', () => {
    for (const args of [[], ['--all'], ['--ids=1,2,3,4,5'], ['--ids=0'], ['--ids=1,nope'], ['--ids=1,']]) {
        assert.throws(() => parsePilotArgs(args));
    }
    assert.deepEqual(parsePilotArgs(['--ids=4,2,4', '--apply']), { ids: [4,2], apply: true });
});

test('JPEG encoding fixes orientation, limits both edges, flattens alpha, and keeps small images small', async () => {
    const large = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#226699' } })
        .jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const result = await compressJpeg(large);
    const meta = await sharp(result.data).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.equal(meta.width, 1280); assert.equal(meta.height, 1920);
    assert.equal(meta.isProgressive, true);
    assert.equal(meta.chromaSubsampling, '4:2:0');
    assert.equal(meta.orientation, undefined);
    assert.ok(result.bytes < large.length);
    const transparent = await sharp({ create: { width: 80, height: 40, channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const small = await compressJpeg(transparent);
    assert.equal(small.width, 80); assert.equal(small.height, 40);
    const { data } = await sharp(small.data).raw().toBuffer({ resolveWithObject: true });
    assert.ok(data.every(channel => channel >= 254));
    await assert.rejects(compressJpeg(Buffer.from('broken image')));
});

test('JPEG keys cannot overwrite originals or collide by basename and distinguish source changes', () => {
    const bytes = Buffer.from('source');
    const first = jpegTarget(original, bytes, 'https://fixture.r2.dev');
    assert.ok(first.key.startsWith('jpeg/images/'));
    assert.ok(first.url.endsWith('.jpg'));
    assert.notEqual(first.url, original);
    assert.notEqual(first.key, jpegTarget(original.replace('/original', '/other/original'), bytes, 'https://fixture.r2.dev').key);
    assert.notEqual(first.key, jpegTarget(original, Buffer.from('new-source'), 'https://fixture.r2.dev').key);
    assert.deepEqual(first, jpegTarget(original, bytes, 'https://fixture.r2.dev'));
});
