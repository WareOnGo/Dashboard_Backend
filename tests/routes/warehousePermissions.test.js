const request = require('supertest');
const { Prisma } = require('@prisma/client');
const { app, prisma, storage, reset, tokenFor, active } = require('../helpers/app');
const { invalidateCapabilities, resolveCapabilities } = require('../../src/utils/access');

const own = { id: 123, city: 'Indore', uploadedBy: 'USER@wareongo.com', WarehouseData: {}, contactNumber: '919800000001' };
const other = { ...own, id: 124, uploadedBy: 'colleague@wareongo.com' };
const auth = (method, path) => request(app)[method](path).set('Authorization', `Bearer ${tokenFor()}`);
const scope = { uploadedBy: { equals: 'user@wareongo.com', mode: 'insensitive' } };
const grant = overrides => {
    invalidateCapabilities();
    prisma.verifiedNumber.findFirst.mockResolvedValue(active({ viewAllWarehouseEntries: false, editAllWarehouseEntries: false, ...overrides }));
};
beforeEach(() => { reset(); grant(); });

test.each(['/api/warehouses?all=true&uploadedBy=colleague', '/api/warehouses?ids=123,124', '/api/warehouses/coordinates', '/api/warehouses/search'])
('own-only scope cannot be overridden through %s', async path => {
    prisma.warehouse.findMany.mockResolvedValue([own]);
    prisma.warehouse.count.mockResolvedValue(1);
    await auth('get', path).expect(200);
    const { where } = prisma.warehouse.findMany.mock.calls[0][0];
    expect(where.AND).toContainEqual(scope);
    if (prisma.warehouse.count.mock.calls.length) expect(prisma.warehouse.count).toHaveBeenCalledWith({ where });
});

test('filter options and statistics only aggregate accessible entries', async () => {
    prisma.warehouse.groupBy.mockResolvedValue([]);
    prisma.warehouse.count.mockResolvedValue(0);
    prisma.$queryRaw.mockResolvedValue([{ averageSpace: null }]);
    await auth('get', '/api/warehouses/filter-options').expect(200);
    await auth('get', '/api/warehouses/statistics').expect(200);
    for (const [options] of prisma.warehouse.groupBy.mock.calls) expect(options.where).toEqual(scope);
    const sql = Prisma.sql(...prisma.$queryRaw.mock.calls[0]);
    expect(sql.text).toContain('w."uploadedBy" ILIKE ');
    expect(sql.values).toContain('user@wareongo.com');
    expect(prisma.warehouse.count).toHaveBeenCalledWith({ where: scope });
});

test('GIS scope is parameterized and intersects caller filters', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    await auth('get', '/api/geo/warehouses?bbox=75,22,76,23&uploadedBy=colleague').expect(200);
    const sql = Prisma.sql(...prisma.$queryRaw.mock.calls[0]);
    expect(sql.text).toContain('w."uploadedBy" ILIKE ');
    expect(sql.text).not.toContain('user@wareongo.com');
    expect(sql.values).toContain('user@wareongo.com');
    expect(sql.values).toContain('%colleague%');
});

test.each([
    '/api/warehouses/124', '/api/warehouses/124/contact-number?reason=Deal',
    '/api/warehouses/124/visit-notes', '/api/warehouses/124/voice-notes/00000000-0000-4000-8000-000000000001/playback',
    '/api/image-labels/warehouse/124',
])('direct read refuses another uploader: %s', async path => {
    prisma.warehouse.findUnique.mockResolvedValue(other);
    await auth('get', path).expect(403);
    expect(prisma.warehouseVisitNote.findMany).not.toHaveBeenCalled();
    expect(prisma.labeledWarehouseImage.findMany).not.toHaveBeenCalled();
});

test('own entry permits case-insensitive exact identity, never a name or substring', async () => {
    prisma.warehouse.findUnique.mockResolvedValue(own);
    await auth('get', '/api/warehouses/123').expect(200);
    for (const uploadedBy of ['QA Fixture', 'other-user@wareongo.com', '', null]) {
        prisma.warehouse.findUnique.mockResolvedValue({ ...own, uploadedBy });
        await auth('get', '/api/warehouses/123').expect(403);
    }
});

test.each(['/api/generate-ppt', '/api/generate-ppt-v2', '/api/generate-ppt-v3', '/api/generate-ppt-godamwale', '/api/generate-ppt-tci', '/api/generate-detailed-ppt', '/api/generate-xlsx-last-mile'])
('mixed exports fail before generating any file: %s', async path => {
    prisma.warehouse.findMany.mockResolvedValue([own, other]);
    await auth('post', path).send({ ids: '123,124' }).expect(403);
    expect(prisma.labeledWarehouseImage.findMany).not.toHaveBeenCalled();
});

test('view all does not grant edit all and payload attribution cannot bypass ownership', async () => {
    grant({ viewAllWarehouseEntries: true });
    prisma.warehouse.findUnique.mockResolvedValue(other);
    await auth('get', '/api/warehouses/124').expect(200);
    await auth('put', '/api/warehouses/124').send({ visibility: true, uploadedBy: own.uploadedBy }).expect(403);
    expect(prisma.warehouse.update).not.toHaveBeenCalled();
});

test('edit own allows own edits and preserves original attribution', async () => {
    prisma.warehouse.findUnique.mockResolvedValue(own);
    prisma.$queryRawUnsafe = jest.fn().mockResolvedValue([]);
    prisma.warehouse.update.mockImplementation(async ({ data }) => ({ ...own, ...data }));
    await auth('put', '/api/warehouses/123').send({ visibility: true, uploadedBy: other.uploadedBy }).expect(200);
    const { data } = prisma.warehouse.update.mock.calls[0][0];
    expect(data.visibility).toBe(true);
    expect(data).not.toHaveProperty('uploadedBy');
});

test.each([
    ['post', '/api/warehouses'], ['post', '/api/warehouses/presigned-url'],
    ['post', '/api/warehouses/presigned-urls/batch'], ['put', '/api/warehouses/123'],
    ['post', '/api/warehouses/123/visit-notes'], ['put', '/api/warehouses/123/visit-notes/1'],
])('read-only users cannot write through %s %s', async (method, path) => {
    grant({ editOwnWarehouseEntries: false });
    await auth(method, path).send({}).expect(403);
    expect(prisma.warehouse.findUnique).not.toHaveBeenCalled();
    expect(prisma.warehouse.update).not.toHaveBeenCalled();
});

test.each([{ dashboardAccess: false }, { viewOwnWarehouseEntries: false }, { is_active: false }])
('parent revocation overrides dormant or contradictory child grants: %j', async overrides => {
    grant({ viewAllWarehouseEntries: true, editAllWarehouseEntries: true, ...overrides });
    await auth('get', '/api/warehouses').expect(403);
    await auth('put', '/api/warehouses/123').send({ visibility: true }).expect(403);
});

test('active admins inherit the warehouse grants; edit all still cannot delete', async () => {
    grant({ adminAccess: true, dashboardAccess: false, viewOwnWarehouseEntries: false });
    prisma.warehouse.findUnique.mockResolvedValue(other);
    await auth('get', '/api/warehouses/124').expect(200);
    grant({ viewAllWarehouseEntries: true, editAllWarehouseEntries: true });
    await auth('delete', '/api/warehouses/124').expect(403);
});


test('raw file metadata and validation cannot reveal another uploader’s files', async () => {
    storage.send.mockResolvedValue({ ContentType: 'image/jpeg', ContentLength: 100, Metadata: { uploader: other.uploadedBy } });
    await auth('get', '/api/warehouses/files/other.jpg').expect(403);
    await auth('post', '/api/warehouses/files/other.jpg/validate').send({}).expect(403);
    storage.send.mockResolvedValue({ ContentType: 'image/jpeg', ContentLength: 100, Metadata: { uploader: own.uploadedBy } });
    await auth('get', '/api/warehouses/files/own.jpg').expect(200);
    await auth('post', '/api/warehouses/files/own.jpg/validate').send({}).expect(200);
});

test('the admin API persists the entire cascade and invalidates the employee’s warm access cache', async () => {
    process.env.ADMIN_EMAILS = 'boss@wareongo.com';
    let employee = active();
    prisma.verifiedNumber.findFirst.mockImplementation(async () => employee);
    prisma.verifiedNumber.findUnique.mockImplementation(async () => employee);
    prisma.verifiedNumber.update.mockImplementation(async ({ data }) => (employee = { ...employee, ...data }));
    prisma.warehouse.findMany.mockResolvedValue([]);
    prisma.warehouse.count.mockResolvedValue(0);
    await auth('get', '/api/warehouses').expect(200);
    const saved = await request(app).patch('/api/verified-numbers/admin/7')
        .set('Authorization', `Bearer ${tokenFor('boss@wareongo.com')}`)
        .send({ viewOwnWarehouseEntries: false }).expect(200);
    expect(saved.body).toMatchObject({
        dashboardAccess: true, viewOwnWarehouseEntries: false, editOwnWarehouseEntries: false,
        viewAllWarehouseEntries: false, editAllWarehouseEntries: false,
    });
    await auth('get', '/api/warehouses').expect(403);
    await auth('put', '/api/warehouses/123').send({ visibility: true }).expect(403);
    expect(prisma.warehouse.update).not.toHaveBeenCalled();
});

test('an all-to-own revocation on another instance immediately restricts reads despite a warm cache', async () => {
    grant({ viewAllWarehouseEntries: true });
    expect((await resolveCapabilities('user@wareongo.com')).WAREHOUSE_VIEW_ALL).toBe(true);
    // Simulate another process committing a revocation without clearing this cache.
    prisma.verifiedNumber.findFirst.mockResolvedValue(active({ viewAllWarehouseEntries: false, editAllWarehouseEntries: false }));
    prisma.warehouse.findUnique.mockResolvedValue(other);
    await auth('get', '/api/warehouses/124').expect(403);
    prisma.warehouse.findMany.mockResolvedValue([]);
    prisma.warehouse.count.mockResolvedValue(0);
    await auth('get', '/api/warehouses?all=true').expect(200);
    expect(prisma.warehouse.findMany.mock.calls[0][0].where.AND).toContainEqual(scope);
});

test.each([
    '/api/warehouses', '/api/warehouses/124', '/api/warehouses/filter-options',
    '/api/warehouses/124/contact-number?reason=Deal', '/api/warehouses/124/visit-notes',
    '/api/image-labels/warehouse/124', '/api/geo/warehouses?bbox=75,22,76,23',
    '/api/warehouses/files/other.jpg',
])('cross-instance view revocation rejects a cached grant at %s', async path => {
    await resolveCapabilities('user@wareongo.com');
    prisma.verifiedNumber.findFirst.mockResolvedValue(active({ viewOwnWarehouseEntries: false }));
    await auth('get', path).expect(403);
    expect(prisma.warehouse.findMany).not.toHaveBeenCalled();
    expect(prisma.warehouse.findUnique).not.toHaveBeenCalled();
    expect(storage.send).not.toHaveBeenCalled();
});

test('warehouse reads fail closed during a roster outage even with a cached grant', async () => {
    await resolveCapabilities('user@wareongo.com');
    prisma.verifiedNumber.findFirst.mockRejectedValue(new Error('Roster unavailable'));
    await auth('get', '/api/warehouses').expect(403);
    expect(prisma.warehouse.findMany).not.toHaveBeenCalled();
});
