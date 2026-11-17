const { randomBytes } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const WarehouseModel = require('../../src/models/warehouseModel');
const WarehouseService = require('../../src/services/warehouseService');
const { warehouseMapFilters } = require('../../src/utils/warehouseMapFilters');
const { warehouseScope } = require('../../src/utils/warehouseAccess');
const testDatabaseUrl = require('../helpers/testDatabaseUrl');

// Run production search against synthetic values in a disposable schema: the
// Prisma candidate and id reads, the in-memory matcher, and the map's id filter.
const schema = `behavior_qa_${randomBytes(8).toString('hex')}`;
const baseUrl = testDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
const url = new URL(baseUrl);
url.searchParams.set('schema', schema);
const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
const model = new WarehouseModel(prisma);
const service = new WarehouseService(model);
let created = false;

beforeAll(async () => {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    created = true;
    await prisma.$executeRawUnsafe(`CREATE TABLE "Warehouse" (
        id integer PRIMARY KEY, "contactNumber" text, alt_phone_number text,
        address text DEFAULT 'Industrial area', city text DEFAULT 'Indore',
        "contactPerson" text DEFAULT 'Fixture owner', "warehouseType" text DEFAULT 'PEB',
        "warehouseOwnerType" text DEFAULT 'Owner', micromarket text[] DEFAULT '{}',
        "ratePerSqft" text DEFAULT '25', "totalSpaceSqft" integer[] DEFAULT '{10000}',
        "createdAt" timestamp(3) DEFAULT '2026-01-01', state text DEFAULT 'Madhya Pradesh',
        "postalCode" text, "ownerAltPoc" text, "ownerCompanyName" text, "uploadedBy" text
    )`);
    const phones = [
        ['9876543210', null], ['+919876543210', null], ['919876543210', null],
        ['+91 (98765) 43210', null], ['09876543210', null], ['0091.98765.43210', null],
        ['9000000000', '+91 98765-43210'], ['9000000000 / 98765-43210', null],
        ['9000098765,4321099999', null],
        // contactNumber is NOT NULL in the schema, so the "no number" row is empty.
        ['', null], ['8765432109', null],
        ['9123456789', null], ['+91 (91234) 56789', null], ['+1 (415) 555-0123', null],
    ];
    for (const [index, [contact, alternate]] of phones.entries()) {
        await prisma.$executeRaw`INSERT INTO "Warehouse" (id, "contactNumber", alt_phone_number)
            VALUES (${index + 1}, ${contact}, ${alternate})`;
    }
    await prisma.$executeRaw`INSERT INTO "Warehouse" (id, "contactNumber", city, "ratePerSqft")
        VALUES (15, '9876543210', 'Mumbai', '50')`;
});

afterAll(async () => {
    try {
        await prisma.$disconnect();
        if (created) await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
        await admin.$disconnect();
    }
});

/**
 * Ids the list shows for `filters`, sorted. Also runs the map's id filter
 * (`w.id = ANY(...)`) on Postgres with the same filters, which must select the
 * same rows.
 */
async function matchingIds(filters) {
    const { where, search } = await service.resolveSearch(filters);
    const ids = (await prisma.warehouse.findMany({ where, select: { id: true } })).map(row => row.id).sort((a, b) => a - b);
    const map = await prisma.$queryRaw`SELECT w.id FROM "Warehouse" w
        WHERE TRUE ${warehouseMapFilters(filters, search ? search.ids : null)} ORDER BY w.id`;
    expect(map.map(row => row.id)).toEqual(ids);
    return ids;
}

test.each([
    '9876543210', '+919876543210', '919876543210', '+91 (98765) 43210',
    '0091 98765-43210', '09876543210', '98765.43210',
])('list and map find %s across stored phone formats', async search => {
    expect(await matchingIds({ search })).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 15]);
});

test('phone matches intersect location, explicit IDs and numeric ranges', async () => {
    const filters = { search: '+91 9876543210', city: 'Indore', ids: '2,4,7,15', minArea: 5000, maxRate: 30 };
    expect(await matchingIds(filters)).toEqual([2, 4, 7]);
});

test('a pasted ID list resolves in pasted order and reports what it could not show', async () => {
    const { search } = await service.resolveSearch({ search: '15, 0, 2, 99\n7', city: 'Indore' });
    expect(search.ids).toEqual([2, 7]);
    expect(search.summary).toEqual({ mode: 'ids', requested: 5, missingIds: ['0', '99'], excludedIds: ['15'] });
});

test('own-only search hides other owners from ranked results and pasted-ID diagnostics', async () => {
    const scope = warehouseScope({ email: 'own_scope@example.test', capabilities: {
        DASHBOARD: true, WAREHOUSE_VIEW_OWN: true, WAREHOUSE_VIEW_ALL: false,
    } });
    await prisma.$executeRaw`INSERT INTO "Warehouse" (id, "contactNumber", address, city, "uploadedBy") VALUES
        (201, '', 'Scope fixture', 'Indore', 'own_scope@example.test'),
        (202, '', 'Scope fixture', 'Indore', 'other@example.test'),
        (203, '', 'Scope fixture', 'Mumbai', 'own_scope@example.test'),
        (204, '', 'Scope fixture', 'Indore', 'OWN_SCOPE@EXAMPLE.TEST'),
        (205, '', 'Scope fixture', 'Indore', 'ownXscope@example.test')`;
    try {
        const ranked = await service.resolveSearch({ search: 'Scope fixture', city: 'Indore' }, scope);
        expect([...ranked.search.ids].sort()).toEqual([201, 204]);
        const ids = await prisma.warehouse.findMany({ where: ranked.where, select: { id: true }, orderBy: { id: 'asc' } });
        expect(ids.map(row => row.id)).toEqual([201, 204]);
        const pasted = await service.resolveSearch({ search: '204,202,203,201,205,999', city: 'Indore' }, scope);
        expect(pasted.search.ids).toEqual([204, 201]);
        expect(pasted.search.summary).toEqual({ mode: 'ids', requested: 6,
            missingIds: ['202', '205', '999'], excludedIds: ['203'] });
    } finally {
        await prisma.$executeRaw`DELETE FROM "Warehouse" WHERE id BETWEEN 201 AND 205`;
    }
});

test('ranked order survives the real candidate read: exact micromarket, then address, newest first', async () => {
    await prisma.$executeRaw`INSERT INTO "Warehouse" (id, "contactNumber", micromarket, address, "createdAt") VALUES
        (101, '', '{Peenya}', 'Plot 1', '2026-02-01'), (102, '', '{}', 'Peenya 2nd Stage', '2026-09-01'),
        (103, '', '{Peenya}', 'Plot 3', '2026-05-01'), (104, '', '{Cheemasandra}', 'Plot 4', '2026-10-01')`;
    try {
        const { search } = await service.resolveSearch({ search: 'peenya' });
        expect(search.ids).toEqual([103, 101, 102]);
    } finally {
        await prisma.$executeRaw`DELETE FROM "Warehouse" WHERE id BETWEEN 101 AND 104`;
    }
});

test.each([
    ['9123456789', [12, 13]], ['+91 91234 56789', [12, 13]],
    ['+1 (415) 555-0123', [14]], ['5550', [14]], ['9998887776', []],
    ['12', [12]], ['Sector 9876', []], ['Fixture owner', Array.from({ length: 15 }, (_, i) => i + 1)],
])('preserves ID/text searches and avoids unrelated phone matches for %s', async (search, ids) => {
    expect(await matchingIds({ search })).toEqual(ids);
});
