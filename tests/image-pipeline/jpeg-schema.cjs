const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
const testDatabaseUrl = require('../helpers/testDatabaseUrl');
const { migrateJpeg } = require('../../scripts/migrateImageJpeg');

// This test modifies fixtures only; the guard rejects all production URLs.
const databaseUrl = testDatabaseUrl(process.env.TEST_DATABASE_URL);
const fields = ['jpegAt', 'jpegBytes', 'jpegError', 'jpegStatus', 'jpegUrl', 'jpegVersion'];

test('JPEG migration adds only six fields, preserves originals/WebP/labels and can be reapplied', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
        await prisma.$executeRawUnsafe('TRUNCATE "Warehouse", labeled_warehouse_images RESTART IDENTITY CASCADE');
        for (const field of fields) {
            await prisma.$executeRawUnsafe(`ALTER TABLE labeled_warehouse_images DROP COLUMN IF EXISTS "${field}" CASCADE`);
        }
        await prisma.$executeRawUnsafe(`INSERT INTO "Warehouse" (id, media, photos, "photosWebp") VALUES
          (1, '{"images":["https://fixture.r2.dev/raw.jpg"],"videos":["https://fixture.r2.dev/video.mp4"],"docs":[]}',
           'https://fixture.r2.dev/raw.jpg', '["https://fixture.r2.dev/webp/raw.webp"]')`);
        await prisma.$executeRawUnsafe(`INSERT INTO labeled_warehouse_images
          ("warehouseId", "imageUrl", classification, description, model, "storageBucket", "originalObjectKey",
           "webpUrl", "webpObjectKey", "webpBytes", "webpStatus") VALUES
          (1, 'https://fixture.r2.dev/raw.jpg', 'INDOOR', 'Original caption', 'fixture', 'fixture-bucket', 'raw.jpg',
           'https://fixture.r2.dev/webp/raw.webp', 'webp/raw.webp', 1234, 'READY')`);
        const snapshot = () => prisma.$queryRawUnsafe(`SELECT to_jsonb(w) AS warehouse, to_jsonb(l) AS image
          FROM "Warehouse" w JOIN labeled_warehouse_images l ON l."warehouseId" = w.id`);
        const [before] = await snapshot();
        const report = await migrateJpeg(prisma, true);
        assert.equal(report.oldColumnsPreserved, true);
        assert.equal(report.mediaPreserved, true);
        const [after] = await snapshot();
        assert.deepEqual(after.warehouse, before.warehouse);
        assert.deepEqual(Object.keys(after.image).filter(key => !(key in before.image)).sort(), fields);
        assert.deepEqual(Object.fromEntries(Object.keys(before.image).map(key => [key, after.image[key]])), before.image);
        assert.equal(after.image.jpegStatus, 'PENDING');
        assert.equal(after.image.jpegUrl, null);
        await assert.rejects(prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images SET "jpegStatus" = 'READY'`));
        await prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images SET
          "jpegUrl" = 'https://fixture.r2.dev/jpeg/raw.jpg', "jpegBytes" = 208000,
          "jpegAt" = now(), "jpegVersion" = 'sharp-jpeg-m1920-q82-v1', "jpegStatus" = 'READY'`);
        await assert.rejects(prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images SET "jpegUrl" = "webpUrl"`));
        await assert.rejects(prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images SET "jpegBytes" = 0`));
        const completed = await snapshot();
        assert.equal((await migrateJpeg(prisma, true)).oldColumnsPreserved, true);
        assert.deepEqual(await snapshot(), completed);
    } finally { await prisma.$disconnect(); }
});
