const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
const testDatabaseUrl = require('../helpers/testDatabaseUrl');
const { dropUnusedJpeg, JPEG_FIELDS } = require('../../scripts/dropUnusedImageJpeg');
const { migrate } = require('../../scripts/migrateImagePipeline');

// This harness only accepts the dedicated disposable local database.
const prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl(process.env.TEST_DATABASE_URL) } } });
const snapshot = () => prisma.$queryRawUnsafe(`SELECT to_jsonb(w) AS warehouse, to_jsonb(l) AS image
  FROM "Warehouse" w JOIN labeled_warehouse_images l ON l."warehouseId" = w.id`);
const jpegColumns = async () => (await prisma.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'labeled_warehouse_images' AND column_name LIKE 'jpeg%'`))
    .map(row => row.column_name).sort();

beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "Warehouse", labeled_warehouse_images RESTART IDENTITY CASCADE');
    // Recreate the prior schema only as a fixture, including its index/checks.
    await prisma.$executeRawUnsafe(`ALTER TABLE labeled_warehouse_images
      ADD COLUMN IF NOT EXISTS "jpegUrl" text, ADD COLUMN IF NOT EXISTS "jpegBytes" bigint,
      ADD COLUMN IF NOT EXISTS "jpegAt" timestamptz(3), ADD COLUMN IF NOT EXISTS "jpegVersion" text,
      ADD COLUMN IF NOT EXISTS "jpegStatus" varchar(16) NOT NULL DEFAULT 'PENDING',
      ADD COLUMN IF NOT EXISTS "jpegError" text`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "labeled_warehouse_images_jpegStatus_idx"
      ON labeled_warehouse_images ("jpegStatus")`);
    await prisma.$executeRawUnsafe(`ALTER TABLE labeled_warehouse_images DROP CONSTRAINT IF EXISTS jpeg_cleanup_fixture_check`);
    await prisma.$executeRawUnsafe(`ALTER TABLE labeled_warehouse_images ADD CONSTRAINT jpeg_cleanup_fixture_check
      CHECK ("jpegStatus" IN ('PENDING','READY','FAILED','UNSUPPORTED'))`);
    await prisma.$executeRawUnsafe(`INSERT INTO "Warehouse" (id,media,photos,"photosWebp") VALUES
      (1,'{"images":["https://fixture.r2.dev/raw.jpg"],"videos":["https://fixture.r2.dev/video.mp4"],"docs":[]}',
       'https://fixture.r2.dev/raw.jpg','["https://fixture.r2.dev/webp/raw.webp"]')`);
    await prisma.$executeRawUnsafe(`INSERT INTO labeled_warehouse_images
      ("warehouseId","imageUrl",classification,description,model,"labelledAt","documentStatus","storageBucket","originalObjectKey",
       "webpUrl","webpObjectKey","webpBytes","webpStatus") VALUES
      (1,'https://fixture.r2.dev/raw.jpg','INDOOR','Original caption','fixture',now(),'READY','fixture-bucket','raw.jpg',
       'https://fixture.r2.dev/webp/raw.webp','webp/raw.webp',1234,'READY')`);
});
after(async () => { await migrate(prisma, true); await prisma.$disconnect(); });

test('preview is read-only; cleanup preserves every other value and can be repeated', async () => {
    const [before] = await snapshot();
    const preview = await dropUnusedJpeg(prisma);
    assert.equal(preview.populatedRows, 0);
    assert.deepEqual(preview.columnsToDrop, JPEG_FIELDS);
    assert.deepEqual(await snapshot(), [before]);

    const report = await dropUnusedJpeg(prisma, true);
    assert.deepEqual(report.removedColumns, JPEG_FIELDS);
    assert.equal(report.remainingImageValuesPreserved, true);
    assert.equal(report.mediaPreserved, true);
    assert.deepEqual(await jpegColumns(), []);
    const [after] = await snapshot();
    assert.deepEqual(after.warehouse, before.warehouse);
    assert.deepEqual(after.image, Object.fromEntries(Object.entries(before.image).filter(([key]) => !JPEG_FIELDS.includes(key))));
    assert.deepEqual((await dropUnusedJpeg(prisma, true)).removedColumns, []);
    assert.deepEqual(await snapshot(), [after]);
    await migrate(prisma, true);
    assert.deepEqual(await jpegColumns(), [...JPEG_FIELDS].sort(), 'The JPEG pilot migration restores its fields');
});

for (const [field, value] of [
    ['jpegUrl', "'https://fixture.r2.dev/jpeg/raw.jpg'"], ['jpegBytes', '123'],
    ['jpegAt', 'now()'], ['jpegVersion', "'fixture-v1'"],
    ['jpegStatus', "'FAILED'"], ['jpegError', "'fixture failure'"],
]) {
    test(`cleanup refuses populated ${field} without modifying data or dropping columns`, async () => {
        await prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images SET "${field}"=${value}`);
        const before = await snapshot();
        assert.equal((await dropUnusedJpeg(prisma)).populatedRows, 1);
        await assert.rejects(dropUnusedJpeg(prisma, true), /Refusing to drop JPEG columns/);
        assert.deepEqual(await snapshot(), before);
        assert.deepEqual(await jpegColumns(), [...JPEG_FIELDS].sort());
    });
}

test('an unexpected dependent view stops cleanup and rolls back all column drops', async () => {
    await prisma.$executeRawUnsafe('CREATE VIEW jpeg_cleanup_fixture_view AS SELECT "jpegUrl" FROM labeled_warehouse_images');
    try {
        const before = await snapshot();
        await assert.rejects(dropUnusedJpeg(prisma, true), /depend/);
        assert.deepEqual(await jpegColumns(), [...JPEG_FIELDS].sort());
        assert.deepEqual(await snapshot(), before);
    } finally {
        await prisma.$executeRawUnsafe('DROP VIEW jpeg_cleanup_fixture_view');
        await dropUnusedJpeg(prisma, true);
    }
});
