const request = require('supertest');
const { app, prisma, reset, tokenFor, active } = require('../helpers/app');
prisma.$queryRawUnsafe = jest.fn();
const auth = req => req.set('Authorization', `Bearer ${tokenFor()}`);
let saved;
beforeEach(() => {
    reset();
    saved = { id: 123, city: 'Pune', contactNumber: '919800000001', uploadedBy: 'original@example.test', lastEditedBy: null, WarehouseData: {} };
    prisma.verifiedNumber.findFirst.mockResolvedValue(active({ reviewerAccess: true }));
    prisma.$queryRawUnsafe.mockResolvedValue([]);
    prisma.warehouse.findUnique.mockImplementation(async () => saved);
    prisma.warehouse.update.mockImplementation(async ({ data }) => {
        saved = { ...saved, ...data };
        return saved;
    });
});

test('warehouse API persists the authenticated editor and returns it on subsequent reads', async () => {
    const { body } = await auth(request(app).put('/api/warehouses/123')).send({
        city: 'Mumbai', lastEditedBy: 'spoofed@example.test', updatedByEmail: 'spoofed@example.test', updatedBy: 'spoofed-id',
    }).expect(200);
    expect(body.lastEditedBy).toBe('user@wareongo.com');
    expect(body.uploadedBy).toBe('original@example.test');
    expect(body).not.toHaveProperty('contactNumber');
    expect(prisma.warehouse.update.mock.calls[0][0].data.lastEditedBy).toBe('user@wareongo.com');
    const detail = await auth(request(app).get('/api/warehouses/123')).expect(200);
    expect(detail.body.lastEditedBy).toBe('user@wareongo.com');
    prisma.warehouse.findMany.mockResolvedValue([saved]);
    prisma.warehouse.count.mockResolvedValue(1);
    const list = await auth(request(app).get('/api/warehouses')).expect(200);
    expect(list.body.data[0].lastEditedBy).toBe('user@wareongo.com');
});

test('visibility edits also record the editor', async () => {
    const { body } = await auth(request(app).put('/api/warehouses/123')).send({ visibility: true }).expect(200);
    expect(body).toMatchObject({ visibility: true, lastEditedBy: 'user@wareongo.com' });
});

test('staging API takes the editor from the authenticated reviewer', async () => {
    const id = '00000000-0000-4000-8000-000000000123';
    prisma.stagedWarehouse.findUnique.mockResolvedValue({ id, city: 'Pune', reviewStatus: 'PENDING' });
    prisma.stagedWarehouse.update.mockImplementation(async ({ data }) => ({ id, ...data }));
    const { body } = await auth(request(app).patch(`/api/staging/${id}`)).send({ city: 'Mumbai', lastEditedBy: 'spoofed@example.test' }).expect(200);
    expect(body.lastEditedBy).toBe('user@wareongo.com');
});
