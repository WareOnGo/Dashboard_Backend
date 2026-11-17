const { randomBytes } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { migrate } = require('../../scripts/migrateWarehouseLastEditedBy');
const testDatabaseUrl = require('../helpers/testDatabaseUrl');
const schema = 'behavior_qa_' + randomBytes(8).toString('hex');
const base = testDatabaseUrl(process.env.TEST_DATABASE_URL);
const url = new URL(base);
url.searchParams.set('schema', schema);
const root = new PrismaClient({ datasources: { db: { url: base } } });
const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
let created = false;
beforeAll(async () => {
    await root.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    created = true;
    await db.$executeRawUnsafe('CREATE TABLE "Warehouse" (id integer PRIMARY KEY, "uploadedBy" text)');
    await db.$executeRawUnsafe('CREATE TABLE "StagedWarehouse" (id text PRIMARY KEY)');
    await db.$executeRawUnsafe('INSERT INTO "Warehouse" VALUES (1, \'original@example.test\')');
    await db.$executeRawUnsafe('INSERT INTO "StagedWarehouse" VALUES (\'legacy-submission\')');
});
afterAll(async () => {
    await db.$disconnect();
    if (created) await root.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await root.$disconnect();
});

test('migration adds nullable editor columns, preserves existing data and is safe to repeat', async () => {
    expect((await migrate(db)).columns.every(column => !column.exists)).toBe(true);
    // Inspecting does not mutate the database.
    expect((await migrate(db)).columns.every(column => !column.exists)).toBe(true);
    expect((await migrate(db, true)).addedTo).toEqual(['Warehouse', 'StagedWarehouse']);
    expect(await db.$queryRaw`SELECT * FROM "Warehouse"`).toEqual([
        { id: 1, uploadedBy: 'original@example.test', lastEditedBy: null },
    ]);
    expect(await db.$queryRaw`SELECT * FROM "StagedWarehouse"`).toEqual([
        { id: 'legacy-submission', lastEditedBy: null },
    ]);
    await db.$executeRaw`UPDATE "Warehouse" SET "lastEditedBy" = ${'editor@example.test'} WHERE id = 1`;
    expect((await migrate(db, true)).addedTo).toEqual([]);
    expect(await db.$queryRaw`SELECT "lastEditedBy" FROM "Warehouse" WHERE id = 1`)
        .toEqual([{ lastEditedBy: 'editor@example.test' }]);
    // User IDs use the same text column.
    await db.$executeRaw`UPDATE "StagedWarehouse" SET "lastEditedBy" = ${'42'} WHERE id = ${'legacy-submission'}`;
    expect(await db.$queryRaw`SELECT "lastEditedBy" FROM "StagedWarehouse"`)
        .toEqual([{ lastEditedBy: '42' }]);
});
