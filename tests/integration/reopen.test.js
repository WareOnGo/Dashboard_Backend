const { randomBytes } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const StagedWarehouseModel = require('../../src/models/stagedWarehouseModel');
const testDatabaseUrl = require('../helpers/testDatabaseUrl');

// A separate schema for each run, inside the explicitly guarded disposable DB.
// Only the columns involved in reopening are needed; no production schema push,
// migrations, extensions, seed data, or shared application tables are used.
const schema = `behavior_qa_${randomBytes(8).toString('hex')}`;
const baseUrl = testDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
const url = new URL(baseUrl);
url.searchParams.set('schema', schema);
const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
const model = new StagedWarehouseModel(prisma);
const reviewer = { email: 'reviewer@wareongo.com', name: 'QA Reviewer', ip: '127.0.0.1' };
const reviewedAt = new Date('2026-01-01T12:00:00.123Z');
let created = false;

beforeAll(async () => {
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  created = true;
  for (const sql of [
    `CREATE TYPE "StagingStatus" AS ENUM ('PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED')`,
    `CREATE TABLE "Warehouse" (id integer PRIMARY KEY)`,
    `CREATE TABLE "WarehouseData" ("warehouseId" integer PRIMARY KEY REFERENCES "Warehouse"(id) ON DELETE CASCADE)`,
    `CREATE TABLE "DeletionBlocker" ("warehouseId" integer REFERENCES "Warehouse"(id) ON DELETE RESTRICT)`,
    `CREATE TABLE "StagedWarehouse" (id text PRIMARY KEY, "reviewStatus" "StagingStatus" NOT NULL,
      "warehouseId" integer, "reviewedBy" text, "reviewedAt" timestamp(3), "rejectionReason" text)`,
    `CREATE TABLE audit_logs (id text PRIMARY KEY, action text NOT NULL, entity text NOT NULL,
      "entityId" text, context text, metadata jsonb, "userEmail" text NOT NULL, "userName" text,
      "ipAddress" text, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  ]) await prisma.$executeRawUnsafe(sql);
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "DeletionBlocker", "WarehouseData", "Warehouse", "StagedWarehouse", audit_logs');
});
afterAll(async () => {
  try {
    await prisma.$disconnect();
    if (created) await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  } finally { await admin.$disconnect(); }
});

async function fixture({ status = 'APPROVED', warehouseId = 123, warehouseExists = true } = {}) {
  if (warehouseExists && warehouseId !== null) {
    await prisma.$executeRaw`INSERT INTO "Warehouse" (id) VALUES (${warehouseId})`;
    await prisma.$executeRaw`INSERT INTO "WarehouseData" ("warehouseId") VALUES (${warehouseId})`;
  }
  await prisma.$executeRaw`INSERT INTO "StagedWarehouse"
    (id, "reviewStatus", "warehouseId", "reviewedBy", "reviewedAt", "rejectionReason")
    VALUES ('fixture', ${status}::"StagingStatus", ${warehouseId}, ${reviewer.email}, ${reviewedAt}, 'fixture reason')`;
  return (await prisma.$queryRaw`SELECT * FROM "StagedWarehouse" WHERE id = 'fixture'`)[0];
}
const current = async () => (await prisma.$queryRaw`SELECT * FROM "StagedWarehouse" WHERE id = 'fixture'`)[0];
const warehouses = () => prisma.$queryRaw`SELECT * FROM "Warehouse" ORDER BY id`;
const audits = () => prisma.auditLog.findMany({ where: { action: 'REOPEN' } });

test('approved reopen deletes the master and cascaded data, clears review fields, and records the actual deletion', async () => {
  const row = await fixture();
  expect(await model.reopen(row, reviewer)).toEqual({ id: 'fixture', reviewStatus: 'PENDING', warehouseId: null, reviewedBy: null, reviewedAt: null, rejectionReason: null });
  expect((await current()).reviewStatus).toBe('PENDING');
  expect(await warehouses()).toEqual([]);
  expect(await prisma.$queryRaw`SELECT * FROM "WarehouseData"`).toEqual([]);
  expect(await audits()).toEqual([expect.objectContaining({ metadata: { previousStatus: 'APPROVED', previousWarehouseId: 123, removedWarehouseId: 123 }, userEmail: reviewer.email })]);
});
test('a failed deletion rolls back the staging reset and leaves the original link recoverable; retry succeeds', async () => {
  const row = await fixture();
  await prisma.$executeRaw`INSERT INTO "DeletionBlocker" ("warehouseId") VALUES (123)`;
  await expect(model.reopen(row, reviewer)).rejects.toMatchObject({ code: 'P2010', meta: expect.objectContaining({ code: '23503' }) });
  expect(await current()).toEqual(row);
  expect(await warehouses()).toEqual([{ id: 123 }]);
  expect(await prisma.$queryRaw`SELECT * FROM "WarehouseData"`).toEqual([{ warehouseId: 123 }]);
  expect(await audits()).toEqual([]);
  await prisma.$executeRaw`DELETE FROM "DeletionBlocker"`;
  await model.reopen(row, reviewer);
  expect(await warehouses()).toEqual([]);
  expect(await audits()).toHaveLength(1);
});
test('an already-missing master can be reopened without claiming a deletion in the audit', async () => {
  await model.reopen(await fixture({ warehouseExists: false }), reviewer);
  expect((await current()).reviewStatus).toBe('PENDING');
  expect((await audits())[0].metadata).toEqual({ previousStatus: 'APPROVED', previousWarehouseId: 123, removedWarehouseId: null });
});
test('a rejected row is reopened without deleting a referenced warehouse', async () => {
  await model.reopen(await fixture({ status: 'REJECTED' }), reviewer);
  expect(await warehouses()).toEqual([{ id: 123 }]);
  expect((await current()).reviewStatus).toBe('PENDING');
  expect((await audits())[0].metadata.removedWarehouseId).toBeNull();
});
test('an approved but unlinked claim can be reopened', async () => {
  await model.reopen(await fixture({ warehouseId: null }), reviewer);
  expect((await current()).reviewStatus).toBe('PENDING');
  expect((await audits())[0].metadata.removedWarehouseId).toBeNull();
});
test.each(['PENDING', 'IN_REVIEW'])('%s rows cannot be reopened', async status => {
  const row = await fixture({ status });
  await expect(model.reopen(row, reviewer)).rejects.toMatchObject({ statusCode: 409 });
  expect(await current()).toEqual(row);
  expect(await warehouses()).toEqual([{ id: 123 }]);
  expect(await audits()).toEqual([]);
});
test.each(['status', 'link', 'reviewer', 'timestamp'])('a stale %s snapshot cannot revoke a newer review', async changed => {
  const row = await fixture();
  if (changed === 'status') await prisma.$executeRaw`UPDATE "StagedWarehouse" SET "reviewStatus" = 'REJECTED'`;
  if (changed === 'link') {
    await prisma.$executeRaw`INSERT INTO "Warehouse" (id) VALUES (456)`;
    await prisma.$executeRaw`UPDATE "StagedWarehouse" SET "warehouseId" = 456`;
  }
  if (changed === 'reviewer') await prisma.$executeRaw`UPDATE "StagedWarehouse" SET "reviewedBy" = 'other@wareongo.com'`;
  if (changed === 'timestamp') await prisma.$executeRaw`UPDATE "StagedWarehouse" SET "reviewedAt" = "reviewedAt" + interval '1 second'`;
  const newer = await current();
  const masters = await warehouses();
  await expect(model.reopen(row, reviewer)).rejects.toMatchObject({ statusCode: 409 });
  expect(await current()).toEqual(newer);
  expect(await warehouses()).toEqual(masters);
  expect(await audits()).toEqual([]);
});
test('30 competing reopen requests produce one success, 29 conflicts, and one audit', async () => {
  const row = await fixture();
  const results = await Promise.allSettled(Array.from({ length: 30 }, () => model.reopen(row, reviewer)));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const failures = results.filter(r => r.status === 'rejected');
  expect(failures).toHaveLength(29);
  expect(failures.every(r => r.reason.statusCode === 409)).toBe(true);
  expect(await warehouses()).toEqual([]);
  expect(await audits()).toHaveLength(1);
});
