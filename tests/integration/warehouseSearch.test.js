const { randomBytes } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const WarehouseModel = require('../../src/models/warehouseModel');
const WarehouseService = require('../../src/services/warehouseService');
const { warehouseMapFilters } = require('../../src/utils/warehouseMapFilters');
const testDatabaseUrl = require('../helpers/testDatabaseUrl');

// Run the production phone SQL against synthetic values in a disposable schema.
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
        "ratePerSqft" text DEFAULT '25', "totalSpaceSqft" integer[] DEFAULT '{10000}'
    )`);
    const phones = [
        ['9876543210', null], ['+919876543210', null], ['919876543210', null],
        ['+91 (98765) 43210', null], ['09876543210', null], ['0091.98765.43210', null],
        ['9000000000', '+91 98765-43210'], ['9000000000 / 98765-43210', null],
        ['9000098765,4321099999', null], [null, null], ['8765432109', null],
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

async function matchingIds(filters) {
    const where = await service.resolveWhere(filters);
    const list = await prisma.warehouse.findMany({ where, select: { id: true }, orderBy: { id: 'asc' } });
    const map = await prisma.$queryRaw`SELECT w.id FROM "Warehouse" w
        WHERE TRUE ${warehouseMapFilters(filters)} ORDER BY w.id`;
    expect(map).toEqual(list);
    expect(await model.count(where)).toBe(list.length);
    return list.map(row => row.id);
}

test.each([
    '9876543210', '+919876543210', '919876543210', '+91 (98765) 43210',
    '0091 98765-43210', '09876543210', '98765.43210',
])('list, count and map agree for %s across stored phone formats', async search => {
    expect(await matchingIds({ search })).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 15]);
});

test('phone matches intersect location, explicit IDs and numeric ranges before paging', async () => {
    const filters = { search: '+91 9876543210', city: 'Indore', ids: '2,4,7,15', minArea: 5000, maxRate: 30 };
    expect(await matchingIds(filters)).toEqual([2, 4, 7]);
    const where = await service.resolveWhere(filters);
    expect(await prisma.warehouse.findMany({
        where, select: { id: true }, orderBy: { id: 'asc' }, skip: 1, take: 1,
    })).toEqual([{ id: 4 }]);
    expect(await model.count(where)).toBe(3);
});

test.each([
    ['9123456789', [12, 13]], ['+91 91234 56789', [12, 13]],
    ['+1 (415) 555-0123', [14]], ['5550', [14]], ['9998887776', []],
    ['12', [12]], ['Sector 9876', []], ['Fixture owner', Array.from({ length: 15 }, (_, i) => i + 1)],
])('preserves ID/text searches and avoids unrelated phone matches for %s', async (search, ids) => {
    expect(await matchingIds({ search })).toEqual(ids);
});
