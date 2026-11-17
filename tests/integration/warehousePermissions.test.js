const { randomBytes } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { migrate } = require('../../scripts/migrateWarehousePermissions');
const { warehouseScope } = require('../../src/utils/warehouseAccess');
const { WAREHOUSE_PERMISSION_COLUMNS: columns } = require('../../src/utils/warehousePermissions');
const VerifiedNumberModel = require('../../src/models/verifiedNumberModel');
const VerifiedNumberService = require('../../src/services/verifiedNumberService');
const WarehouseModel = require('../../src/models/warehouseModel');
const testDatabaseUrl = require('../helpers/testDatabaseUrl');

const schema = `behavior_qa_${randomBytes(8).toString('hex')}`;
const baseUrl = testDatabaseUrl(process.env.TEST_DATABASE_URL);
const root = new PrismaClient({ datasources: { db: { url: baseUrl } } });
const url = new URL(baseUrl);
url.searchParams.set('schema', schema);
const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
let created = false;

beforeAll(async () => { await root.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`); created = true; });
afterAll(async () => {
    await db.$disconnect();
    if (created) await root.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await root.$disconnect();
});
beforeEach(async () => {
    await db.$executeRawUnsafe('DROP TABLE IF EXISTS "Warehouse"');
    await db.$executeRawUnsafe('DROP TABLE IF EXISTS "VerifiedNumber"');
    await db.$executeRawUnsafe(`CREATE TABLE "VerifiedNumber" (
        id serial PRIMARY KEY, phone_number text NOT NULL UNIQUE, name text NOT NULL,
        is_active boolean NOT NULL DEFAULT true, created_at timestamp NOT NULL DEFAULT now(),
        twenty_user_id text UNIQUE, email text UNIQUE, "empID" text UNIQUE,
        role text NOT NULL DEFAULT 'EMPLOYEE', "adminAccess" boolean NOT NULL DEFAULT false,
        "analystAccess" boolean NOT NULL DEFAULT false, "callDashboardAccess" boolean NOT NULL DEFAULT false,
        "dashboardAccess" boolean NOT NULL DEFAULT false, "reviewerAccess" boolean NOT NULL DEFAULT false
    )`);
    await db.$executeRawUnsafe(`INSERT INTO "VerifiedNumber" (id,name,phone_number,email,"dashboardAccess","adminAccess",is_active) VALUES
        (1,'Admin','synthetic-admin','admin@wareongo.com',true,true,true),
        (2,'Employee','synthetic-user','user@wareongo.com',true,false,true),
        (3,'Inactive','synthetic-inactive','inactive@wareongo.com',true,false,false),
        (4,'No dashboard','synthetic-none','none@wareongo.com',false,false,true)`);
});

test('dry-run changes nothing; apply enables all four for every current employee without activating accounts', async () => {
    expect((await migrate(db)).mode).toBe('dry-run');
    const result = await migrate(db, true);
    expect(result.employees).toBe(4);
    expect(result.columns.every(column => !column.existed)).toBe(true);
    const employees = await db.verifiedNumber.findMany({ orderBy: { id: 'asc' } });
    employees.forEach(row => columns.forEach(column => expect(row[column]).toBe(true)));
    expect(employees[2].is_active).toBe(false);
    expect(employees[3].dashboardAccess).toBe(false);
    const fresh = await db.verifiedNumber.create({ data: { id: 5, name: 'New hire', phone_number: 'synthetic-new' } });
    expect(fresh).toMatchObject({ dashboardAccess: true, viewOwnWarehouseEntries: true,
        editOwnWarehouseEntries: true, viewAllWarehouseEntries: true, editAllWarehouseEntries: false });
});

test('rerunning migration preserves every revocation, including restricted new employees', async () => {
    await migrate(db, true);
    await db.verifiedNumber.update({ where: { id: 2 }, data: { viewAllWarehouseEntries: false, editAllWarehouseEntries: false } });
    await db.verifiedNumber.create({ data: { id: 5, name: 'New hire', phone_number: 'synthetic-new',
        dashboardAccess: false, ...Object.fromEntries(columns.map(column => [column, false])) } });
    await migrate(db, true);
    const user = await db.verifiedNumber.findUnique({ where: { id: 2 } });
    expect(user.viewOwnWarehouseEntries).toBe(true);
    expect(user.viewAllWarehouseEntries).toBe(false);
    expect(user.editAllWarehouseEntries).toBe(false);
    const fresh = await db.verifiedNumber.findUnique({ where: { id: 5 } });
    columns.forEach(column => expect(fresh[column]).toBe(false));
});

test('upgrading the original default-off rollout changes only future SQL inserts', async () => {
    await migrate(db, true);
    for (const column of ['dashboardAccess', ...columns]) {
        await db.$executeRawUnsafe(`ALTER TABLE "VerifiedNumber" ALTER COLUMN "${column}" SET DEFAULT false`);
    }
    await db.verifiedNumber.update({ where: { id: 2 }, data: { viewAllWarehouseEntries: false, editAllWarehouseEntries: false } });
    const before = await db.verifiedNumber.findMany({ orderBy: { id: 'asc' } });
    await migrate(db, true);
    expect(await db.verifiedNumber.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    // SQL insert independently verifies the database defaults, without relying
    // on defaults embedded in the generated Prisma client or the admin service.
    const [fresh] = await db.$queryRaw`INSERT INTO "VerifiedNumber" (id, name, phone_number)
        VALUES (5, 'New hire', 'synthetic-new') RETURNING *`;
    expect(fresh).toMatchObject({ dashboardAccess: true, viewOwnWarehouseEntries: true,
        editOwnWarehouseEntries: true, viewAllWarehouseEntries: true, editAllWarehouseEntries: false });
});

test('admin updates persist cascades atomically and audit every changed child permission', async () => {
    await migrate(db, true);
    const service = new VerifiedNumberService(new VerifiedNumberModel(db));
    const actor = { email: 'admin@wareongo.com' };
    const result = await service.update(2, { viewOwnWarehouseEntries: false }, actor);
    columns.forEach(column => expect(result.row[column]).toBe(false));
    expect(result.changes.map(change => change.field).sort()).toEqual([...columns].sort());
    const enabled = await service.update(2, { editAllWarehouseEntries: true }, actor);
    columns.forEach(column => expect(enabled.row[column]).toBe(true));
    const conflicting = await service.update(2, { dashboardAccess: false, editAllWarehouseEntries: true }, actor);
    columns.forEach(column => expect(conflicting.row[column]).toBe(false));
    expect(conflicting.row.dashboardAccess).toBe(false);
});

test('PostgreSQL ownership filters treat underscore, percent, and backslash as literal email characters', async () => {
    await db.$executeRawUnsafe('CREATE TABLE "Warehouse" (id serial PRIMARY KEY, "uploadedBy" text NOT NULL)');
    const email = 'user_100%\\name@wareongo.com';
    await db.$executeRaw`INSERT INTO "Warehouse" ("uploadedBy") VALUES (${email.toUpperCase()}), ('userX100anythingname@wareongo.com'), ('other@wareongo.com')`;
    const user = { email, capabilities: { DASHBOARD: true, WAREHOUSE_VIEW_OWN: true } };
    const where = warehouseScope(user);
    expect(await db.warehouse.findMany({ where, select: { id: true } })).toEqual([{ id: 1 }]);
    expect(await db.warehouse.count({ where })).toBe(1);
    const gis = await db.$queryRaw`SELECT id FROM "Warehouse" WHERE "uploadedBy" ILIKE ${where.uploadedBy.equals}`;
    expect(gis).toEqual([{ id: 1 }]);
});

test('statistics aggregate actual array-valued areas without including another owner', async () => {
    await db.$executeRawUnsafe(`CREATE TABLE "Warehouse" (
        id serial PRIMARY KEY, "uploadedBy" text NOT NULL, "totalSpaceSqft" integer[],
        state text, "warehouseType" text
    )`);
    await db.$executeRawUnsafe(`INSERT INTO "Warehouse" ("uploadedBy", "totalSpaceSqft", state, "warehouseType") VALUES
        ('USER@wareongo.com', '{1000,2000}', 'Own state', 'PEB'),
        ('user@wareongo.com', '{5000}', 'Own state', 'PEB'),
        ('user@wareongo.com', '{}', 'Own state', 'PEB'),
        ('other@wareongo.com', '{900000}', 'Other state', 'RCC')`);
    const model = new WarehouseModel(db);
    const where = warehouseScope({ email: 'user@wareongo.com', capabilities: { DASHBOARD: true, WAREHOUSE_VIEW_OWN: true } });
    const stats = await model.getStatistics(where);
    expect(stats.totalWarehouses).toBe(3);
    expect(stats.averageSpace).toBe(4000);
    expect(stats.byType).toEqual([{ warehouseType: 'PEB', _count: 3 }]);
    expect(stats.byState).toEqual([{ state: 'Own state', _count: 3 }]);
    const empty = await model.getStatistics(warehouseScope({ email: 'nobody@wareongo.com', capabilities: { DASHBOARD: true, WAREHOUSE_VIEW_OWN: true } }));
    expect(empty.totalWarehouses).toBe(0);
    expect(empty.averageSpace).toBeNull();
});
