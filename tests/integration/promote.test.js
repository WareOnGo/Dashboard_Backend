jest.mock('../../src/models/imagePipelineRepository.cjs', () => ({ registerWarehouseImages: jest.fn(async () => {}) }));
const { randomBytes } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const StagedWarehouseModel = require('../../src/models/stagedWarehouseModel');
const testDatabaseUrl = require('../helpers/testDatabaseUrl');
const schema = `behavior_qa_${randomBytes(8).toString('hex')}`;
const baseUrl = testDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
const url = new URL(baseUrl); url.searchParams.set('schema', schema);
const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
const model = new StagedWarehouseModel(prisma);
const reviewer = { email: 'fixture@example.test' };
const media = { images: ['https://fixture.test/raw.jpg'], videos: [] };
const payload = () => ({ warehouseType: 'Industrial', city: 'Bengaluru', media,
    warehouseData: { latitude: 12.9, longitude: 77.5 } });
let created = false;
beforeAll(async () => {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`); created = true;
    for (const sql of [
        `CREATE TYPE "StagingStatus" AS ENUM ('PENDING','APPROVED','REJECTED')`,
        `CREATE TABLE "Warehouse" (id serial PRIMARY KEY,"warehouseType" text NOT NULL,city text,media jsonb,"createdAt" timestamp DEFAULT now(),"status_updated_at" timestamp,"internalOnly" text DEFAULT 'private')`,
        `CREATE TABLE "WarehouseData" (id serial PRIMARY KEY,"warehouseId" int UNIQUE REFERENCES "Warehouse"(id) ON DELETE CASCADE,latitude float8 CHECK(abs(latitude)<=90),longitude float8,geog text DEFAULT 'internal point',embedding text DEFAULT 'internal vector')`,
        `CREATE TABLE "StagedWarehouse" (id text PRIMARY KEY,"reviewStatus" "StagingStatus" NOT NULL DEFAULT 'PENDING',"warehouseId" int,"reviewedBy" text,"reviewedAt" timestamp(3),"rejectionReason" text)`,
        `CREATE TABLE audit_logs (id text PRIMARY KEY,action text NOT NULL,entity text NOT NULL,"entityId" text,context text,metadata jsonb,"userEmail" text NOT NULL,"userName" text,"ipAddress" text,"createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE TABLE captured_events ("warehouseId" int)`,
        `CREATE FUNCTION capture_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO captured_events VALUES(NEW.id); RETURN NEW; END $$`,
        `CREATE TRIGGER capture AFTER INSERT ON "Warehouse" FOR EACH ROW EXECUTE FUNCTION capture_fixture()`,
        `CREATE FUNCTION reject_link_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."reviewedBy"='fail@example.test' THEN RAISE EXCEPTION 'fixture_link_failure'; END IF; RETURN NEW; END $$`,
        `CREATE TRIGGER reject_link BEFORE UPDATE ON "StagedWarehouse" FOR EACH ROW EXECUTE FUNCTION reject_link_fixture()`,
    ]) await prisma.$executeRawUnsafe(sql);
});
beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "WarehouseData","Warehouse","StagedWarehouse",audit_logs,captured_events');
    await prisma.$executeRawUnsafe(`INSERT INTO "StagedWarehouse"(id) VALUES('fixture')`);
});
afterAll(async () => {
    try { await prisma.$disconnect(); if (created) await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.$disconnect(); }
});
const state = async () => (await prisma.$queryRawUnsafe(`SELECT * FROM "StagedWarehouse" WHERE id='fixture'`))[0];
test('approval commits the warehouse, coordinates, original media, link and captured event together', async () => {
    const result = await model.promote('fixture', payload(), reviewer);
    expect(result.media).toEqual(media); expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.WarehouseData.latitude).toBe(12.9);
    expect(result).not.toHaveProperty('internalOnly');
    expect(result.WarehouseData).not.toHaveProperty('geog');
    expect(result.WarehouseData).not.toHaveProperty('embedding');
    expect(await state()).toMatchObject({ reviewStatus: 'APPROVED', warehouseId: result.id, reviewedBy: reviewer.email });
    expect(await prisma.$queryRawUnsafe('SELECT * FROM captured_events')).toEqual([{ warehouseId: result.id }]);
});
test.each(['details', 'link'])('failed %s write leaves no warehouse or event and retains a retryable submission', async failure => {
    const input = payload(); if (failure === 'details') input.warehouseData.latitude = 999;
    await expect(model.promote('fixture', input, failure === 'link' ? { email: 'fail@example.test' } : reviewer)).rejects.toThrow();
    expect(await state()).toMatchObject({ reviewStatus: 'PENDING', warehouseId: null, reviewedBy: null });
    expect(await prisma.$queryRawUnsafe('SELECT * FROM "Warehouse"')).toEqual([]);
    expect(await prisma.$queryRawUnsafe('SELECT * FROM captured_events')).toEqual([]);
    expect((await model.promote('fixture', payload(), reviewer)).id).toEqual(expect.any(Number));
});
test('twenty concurrent approvals produce one linked warehouse and one captured event', async () => {
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => model.promote('fixture', payload(), reviewer)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected').every(result => result.reason.statusCode === 409)).toBe(true);
    expect(await prisma.$queryRawUnsafe('SELECT * FROM captured_events')).toHaveLength(1);
    const row = await state(); expect(row.reviewStatus).toBe('APPROVED');
    await model.reopen(row, reviewer);
    expect(await prisma.$queryRawUnsafe('SELECT * FROM "Warehouse"')).toEqual([]);
    expect((await state()).reviewStatus).toBe('PENDING');
});
