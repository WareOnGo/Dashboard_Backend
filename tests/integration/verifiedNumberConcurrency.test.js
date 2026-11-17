const { randomBytes } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const VerifiedNumberModel = require('../../src/models/verifiedNumberModel');
const VerifiedNumberService = require('../../src/services/verifiedNumberService');
const testDatabaseUrl = require('../helpers/testDatabaseUrl');

const schema = `behavior_qa_${randomBytes(8).toString('hex')}`;
const baseUrl = testDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
const url = new URL(baseUrl);
url.searchParams.set('schema', schema);
const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
const service = new VerifiedNumberService(new VerifiedNumberModel(prisma));
const a = { email: 'admin-a@wareongo.com' }, b = { email: 'admin-b@wareongo.com' };
let created = false;

beforeAll(async () => {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    created = true;
    await prisma.$executeRawUnsafe(`CREATE TABLE "VerifiedNumber" (
        id serial PRIMARY KEY, phone_number text NOT NULL UNIQUE, name text NOT NULL,
        is_active boolean NOT NULL DEFAULT true, created_at timestamp NOT NULL DEFAULT now(),
        twenty_user_id text UNIQUE, email text UNIQUE, "empID" text UNIQUE,
        role text NOT NULL DEFAULT 'EMPLOYEE', "adminAccess" boolean NOT NULL DEFAULT false,
        "analystAccess" boolean NOT NULL DEFAULT false, "callDashboardAccess" boolean NOT NULL DEFAULT false,
        "dashboardAccess" boolean NOT NULL DEFAULT false, "reviewerAccess" boolean NOT NULL DEFAULT false
    )`);
    await require('../../scripts/migrateWarehousePermissions').migrate(prisma, true);
});
beforeEach(async () => {
    process.env.ADMIN_EMAILS = '';
    await prisma.verifiedNumber.deleteMany();
    await prisma.verifiedNumber.createMany({ data: [
        { id: 1, name: 'Admin A', email: a.email, phone_number: 'synthetic-a', adminAccess: true, twenty_user_id: 'twenty-a' },
        { id: 2, name: 'Admin B', email: b.email, phone_number: 'synthetic-b', adminAccess: true, twenty_user_id: 'twenty-b' },
    ] });
});
afterAll(async () => {
    try {
        await prisma.$disconnect();
        if (created) await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    } finally { await admin.$disconnect(); }
});

test('concurrent mutual demotions preserve an active admin', async () => {
    const results = await Promise.allSettled([
        service.update(2, { adminAccess: false }, a),
        service.update(1, { adminAccess: false }, b),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected');
    expect([403, 409]).toContain(rejected.reason.statusCode);
    expect(await prisma.verifiedNumber.count({ where: { is_active: true, adminAccess: true } })).toBe(1);
});

test('an edit on another connection fails promptly while the roster lock is held', async () => {
    let release, acquired;
    const ready = new Promise(resolve => { acquired = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    const transaction = prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(1784056941, 1919247476)`;
        acquired();
        await hold;
    });
    await ready;
    try {
        await expect(service.update(2, { analystAccess: true }, a)).rejects.toMatchObject({ statusCode: 409 });
        expect((await prisma.verifiedNumber.findUnique({ where: { id: 2 } })).analystAccess).toBe(false);
    } finally { release(); await transaction; }
});

test('an actor revoked after the route gate cannot change the roster', async () => {
    await prisma.verifiedNumber.update({ where: { id: 1 }, data: { adminAccess: false } });
    await expect(service.update(2, { analystAccess: true }, a)).rejects.toMatchObject({ statusCode: 403 });
    expect((await prisma.verifiedNumber.findUnique({ where: { id: 2 } })).analystAccess).toBe(false);
});

test('a failed write rolls back and releases the lock for a later edit', async () => {
    await expect(service.update(2, { analystAccess: true, twenty_user_id: 'twenty-a' }, a)).rejects.toMatchObject({ statusCode: 409 });
    expect((await prisma.verifiedNumber.findUnique({ where: { id: 2 } })).analystAccess).toBe(false);
    expect((await service.update(2, { analystAccess: true }, a)).row.analystAccess).toBe(true);
});
