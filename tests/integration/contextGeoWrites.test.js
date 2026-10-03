const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const ContextGeoService = require('../../src/services/contextGeoService');
const { fixture } = require('../fixtures/contextGeo');
const testDatabaseUrl = require('../helpers/testDatabaseUrl');
const { migrate } = require('../../scripts/migrateContextGeoWrites');

const schema = `behavior_qa_${randomBytes(8).toString('hex')}`;
const baseUrl = testDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
const url = new URL(baseUrl); url.searchParams.set('schema', schema);
const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
let created = false, f, service;
const ddl = fs.readFileSync(path.join(__dirname, '../../scripts/sql/contextGeoWrites.sql'), 'utf8')
    .replaceAll('public.', `"${schema}".`).split('-- statement-breakpoint').map(value => value.trim()).filter(Boolean);
beforeAll(async () => {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`); created = true;
    await prisma.$executeRawUnsafe(`CREATE TABLE "VerifiedNumber" (
        id INTEGER PRIMARY KEY,phone_number TEXT NOT NULL,email TEXT NOT NULL,is_active BOOLEAN NOT NULL DEFAULT true,
        "dashboardAccess" BOOLEAN NOT NULL DEFAULT true,"adminAccess" BOOLEAN NOT NULL DEFAULT false)`);
    await prisma.$executeRawUnsafe(`CREATE TABLE point_of_interest (
        id TEXT PRIMARY KEY,name TEXT NOT NULL,category TEXT NOT NULL,lat FLOAT8 NOT NULL,lng FLOAT8 NOT NULL,
        notes TEXT,city TEXT,"createdBy" TEXT NOT NULL,"createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP NOT NULL)`);
    // Execute the same additive migration twice: repeat application must be safe.
    for (let run = 0; run < 2; run++) for (const sql of ddl) await prisma.$executeRawUnsafe(sql);
});
beforeEach(async () => {
    process.env.ADMIN_EMAILS = '';
    await prisma.$executeRaw`DELETE FROM "ContextGeoNonce"`;
    await prisma.$executeRaw`DELETE FROM "ContextGeoWrite"`;
    await prisma.$executeRaw`DELETE FROM point_of_interest`;
    await prisma.$executeRaw`DELETE FROM "VerifiedNumber"`;
    await prisma.$executeRaw`INSERT INTO "VerifiedNumber" (id,phone_number,email) VALUES (7,'919800000001','synthetic@wareongo.com')`;
    f = fixture(); service = new ContextGeoService(prisma, { env: f.env, now: () => f.now });
});
afterAll(async () => {
    try { await prisma.$disconnect(); if (created) await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.$disconnect(); }
});
const counts = async () => (await prisma.$queryRaw`SELECT (SELECT count(*)::int FROM point_of_interest) AS points,
    (SELECT count(*)::int FROM "ContextGeoWrite") AS receipts,(SELECT count(*)::int FROM "ContextGeoNonce") AS nonces`)[0];

test('migration runner verifies real catalog definitions and rejects an incompatible receipt key', async () => {
    // Redirect only the script's constant public-schema references to this isolated schema;
    // no production namespace or database is touched. The catalog SQL remains real.
    const localSql = sql => sql.replaceAll('public.', `"${schema}".`).replaceAll("'public'", `'${schema}'`);
    const local = {
        $queryRaw: (strings, ...values) => {
            if (values.length) throw new Error('Unexpected migration interpolation');
            return prisma.$queryRawUnsafe(localSql(strings.join('')));
        },
        $executeRawUnsafe: sql => prisma.$executeRawUnsafe(localSql(sql)),
        $transaction: statements => prisma.$transaction(statements),
    };
    expect((await migrate(local)).mode).toBe('inspect');
    expect((await migrate(local, true)).mode).toBe('applied');
    await prisma.$executeRawUnsafe('ALTER TABLE "ContextGeoWrite" DROP CONSTRAINT "ContextGeoWrite_pkey"');
    try { await expect(migrate(local)).rejects.toThrow('UNEXPECTED_CONTEXT_GEO_PRIMARY_KEY'); }
    finally { await prisma.$executeRawUnsafe('ALTER TABLE "ContextGeoWrite" ADD PRIMARY KEY (issuer,"employeeId","operationId")'); }
});

test('concurrent identical creates produce exactly one point and one receipt', async () => {
    const results = await Promise.all([service.create(f.point, f.auth()), service.create(f.point, f.auth())]);
    expect(results.map(result => result.replayed).sort()).toEqual([false, true]);
    expect(results[0].data).toEqual(results[1].data);
    expect(results[0].data.createdBy).toBe('synthetic@wareongo.com');
    expect(await counts()).toEqual({ points: 1, receipts: 1, nonces: 2 });
});
test('concurrent same signed nonce writes once and rejects the replay', async () => {
    const auth = f.auth();
    const results = await Promise.allSettled([service.create(f.point, auth), service.create(f.point, auth)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected').reason).toMatchObject({ status: 401 });
    expect(await counts()).toEqual({ points: 1, receipts: 1, nonces: 1 });
});
test('changed content conflicts while changed JSON key order safely replays', async () => {
    const first = await service.create(f.point, f.auth());
    const changed = { ...f.point, lat: 13 };
    await expect(service.create(changed, f.auth(changed))).rejects.toMatchObject({ status: 409 });
    const reordered = Object.fromEntries(Object.entries(f.point).reverse());
    expect((await service.create(reordered, f.auth(reordered))).data).toEqual(first.data);
    expect(await counts()).toEqual({ points: 1, receipts: 1, nonces: 2 });
});
test('point failure rolls back receipt and nonce so a retry can succeed', async () => {
    await prisma.$executeRawUnsafe('ALTER TABLE point_of_interest ADD CONSTRAINT synthetic_reject CHECK (false) NOT VALID');
    const auth = f.auth();
    try { await expect(service.create(f.point, auth)).rejects.toBeDefined(); }
    finally { await prisma.$executeRawUnsafe('ALTER TABLE point_of_interest DROP CONSTRAINT synthetic_reject'); }
    expect(await counts()).toEqual({ points: 0, receipts: 0, nonces: 0 });
    await service.create(f.point, auth);
    expect(await counts()).toEqual({ points: 1, receipts: 1, nonces: 1 });
});
test('receipt failure rolls back the point and nonce together', async () => {
    await prisma.$executeRawUnsafe('ALTER TABLE "ContextGeoWrite" ADD CONSTRAINT synthetic_reject CHECK (false) NOT VALID');
    try { await expect(service.create(f.point, f.auth())).rejects.toBeDefined(); }
    finally { await prisma.$executeRawUnsafe('ALTER TABLE "ContextGeoWrite" DROP CONSTRAINT synthetic_reject'); }
    expect(await counts()).toEqual({ points: 0, receipts: 0, nonces: 0 });
});
test.each(['permission', 'inactive', 'email changed', 'duplicate email', 'inactive duplicate email', 'employee mismatch'])(
    'rechecks %s before replaying a stored receipt', async reason => {
        await service.create(f.point, f.auth());
        if (reason === 'permission') await prisma.$executeRaw`UPDATE "VerifiedNumber" SET "dashboardAccess"=false WHERE id=7`;
        if (reason === 'inactive') await prisma.$executeRaw`UPDATE "VerifiedNumber" SET is_active=false WHERE id=7`;
        if (reason === 'email changed') await prisma.$executeRaw`UPDATE "VerifiedNumber" SET email='changed@wareongo.com' WHERE id=7`;
        if (reason === 'duplicate email') await prisma.$executeRaw`INSERT INTO "VerifiedNumber" (id,phone_number,email) VALUES (8,'919800000002',' SYNTHETIC@wareongo.com ')`;
        if (reason === 'inactive duplicate email') await prisma.$executeRaw`INSERT INTO "VerifiedNumber" (id,phone_number,email,is_active) VALUES (8,'919800000002',' SYNTHETIC@wareongo.com ',false)`;
        const auth = reason === 'employee mismatch' ? f.auth(f.point, { claims: { sub: '8' } }) : f.auth();
        await expect(service.create(f.point, auth)).rejects.toMatchObject({ status: 403 });
        expect(await counts()).toEqual({ points: 1, receipts: 1, nonces: 1 });
    },
);
test('an active dashboard admin may write, but an inactive environment admin may not', async () => {
    await prisma.$executeRaw`UPDATE "VerifiedNumber" SET "dashboardAccess"=false,"adminAccess"=true WHERE id=7`;
    await service.create(f.point, f.auth());
    process.env.ADMIN_EMAILS = 'synthetic@wareongo.com';
    await prisma.$executeRaw`UPDATE "VerifiedNumber" SET is_active=false WHERE id=7`;
    await expect(service.create(f.point, f.auth())).rejects.toMatchObject({ status: 403 });
});
test('operation keys are employee-scoped and key rotation returns original receipt', async () => {
    const first = await service.create(f.point, f.auth());
    const rotated = fixture(); rotated.point = f.point;
    rotated.key.kid = 'rotated-key';
    rotated.env.WAG_CONTEXT_GEO_PUBLIC_KEYS_JSON = JSON.stringify([rotated.key]);
    const next = new ContextGeoService(prisma, { env: rotated.env, now: () => rotated.now });
    expect((await next.create(f.point, rotated.auth(f.point))).data).toEqual(first.data);
    await prisma.$executeRaw`INSERT INTO "VerifiedNumber" (id,phone_number,email) VALUES (8,'919800000002','another@wareongo.com')`;
    const other = await service.create(f.point, f.auth(f.point, { claims: { sub: '8', email: 'another@wareongo.com' } }));
    expect(other.data.id).not.toBe(first.data.id);
    expect(await counts()).toEqual({ points: 2, receipts: 2, nonces: 3 });
});
test('a deleted point is not resurrected by a delayed duplicate operation', async () => {
    const first = await service.create(f.point, f.auth());
    await prisma.$executeRaw`DELETE FROM point_of_interest`;
    expect(await service.create(f.point, f.auth())).toEqual({ ...first, replayed: true });
    expect(await counts()).toEqual({ points: 0, receipts: 1, nonces: 2 });
});
test.each([
    { lat: null }, { lat: true }, { lat: '' }, { lng: '77.6' }, { name: '  ' }, { name: null },
    { category: 'WAREHOUSE' }, { createdBy: 'someone@wareongo.com' }, { employeeId: 8 }, { notes: 'x'.repeat(5001) },
])('invalid point case %# is rejected without any effects', async override => {
    const point = { ...f.point, ...override };
    await expect(service.create(point, f.auth(point))).rejects.toMatchObject({ status: 400 });
    expect(await counts()).toEqual({ points: 0, receipts: 0, nonces: 0 });
});
