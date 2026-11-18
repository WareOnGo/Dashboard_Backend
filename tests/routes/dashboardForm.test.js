const request = require('supertest');
const { app, prisma, reset, active, tokenFor } = require('../helpers/app');
const { completePptForm } = require('../fixtures/pptForm');
const post = path => request(app).post(path).set('Authorization', `Bearer ${tokenFor()}`);
const body = () => ({
    ...completePptForm(),
    warehouseType: 'PEB', address: 'QA locality', city: 'Bangalore', state: 'Karnataka',
    contactPerson: 'QA owner', contactNumber: '+4532123456', uploadedBy: 'Impersonated uploader',
    totalSpaceSqft: [10000], compliances: 'CLU', ratePerSqft: '25',
    googleLocation: 'https://www.google.com/maps?q=0,77',
    warehouseData: { ...completePptForm().warehouseData, landType: 'Warehouse CLU', latitude: 88, longitude: 99, powerKva: '100 HP' },
});
beforeEach(() => {
    reset();
    prisma.verifiedNumber.findFirst.mockResolvedValue(active());
});
test('dashboard resolution requires authentication and dashboard access', async () => {
    await request(app).post('/api/warehouses/resolve-location').send(body()).expect(401);
    prisma.verifiedNumber.findFirst.mockResolvedValue(active({ dashboardAccess: false }));
    await post('/api/warehouses/resolve-location').send(body()).expect(403);
});
test('dashboard resolution checks pins without creating records', async () => {
    const { body: result } = await post('/api/warehouses/resolve-location').send(body()).expect(200);
    expect(result).toMatchObject({ latitude: 0, longitude: 77 });
    expect(prisma.stagedWarehouse.create).not.toHaveBeenCalled();
});
test('new dashboard submissions require land type and a location value', async () => {
    await post('/api/warehouses').send({ ...body(), warehouseData: {} }).expect(400);
    await post('/api/warehouses').send({ ...body(), googleLocation: ' ' }).expect(400);
    expect(prisma.stagedWarehouse.create).not.toHaveBeenCalled();
});

test('older dashboard clients cannot create a new warehouse with missing answers', async () => {
    await post('/api/warehouses').send({ ...body(), googleLocation: null, warehouseData: { landType: null } }).expect(400);
    expect(prisma.stagedWarehouse.create).not.toHaveBeenCalled();
});
test('creation preserves supplied coordinates, authenticated uploader and existing unit strings', async () => {
    prisma.appSetting.findUnique.mockResolvedValue({ value: false });
    prisma.stagedWarehouse.create.mockImplementation(async ({ data }) => ({ ...data, id: '00000000-0000-4000-8000-000000000123' }));
    const input = body();
    delete input.uploadedBy;
    await post('/api/warehouses').send(input).expect(201);
    const data = prisma.stagedWarehouse.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ uploadedBy: 'user@wareongo.com', source: 'DASHBOARD',
        latitude: 88, longitude: 99, powerKva: '100 HP', contactNumber: '+4532123456' });
    expect(data.rawPayload.uploadedBy).toBe('user@wareongo.com');
});

test('a review-only user can resolve a pin without gaining dashboard access', async () => {
    prisma.verifiedNumber.findFirst.mockResolvedValue(active({ dashboardAccess: false, reviewerAccess: true }));
    await post('/api/staging/resolve-location').send(body()).expect(200);
    await post('/api/warehouses').send(body()).expect(403);
});
test('staged location checks reject callers without review access', async () => {
    await post('/api/staging/resolve-location').send(body()).expect(403);
    await request(app).post('/api/staging/resolve-location').send(body()).expect(401);
});

test('dashboard submits short Maps links without contacting Google', async () => {
    prisma.appSetting.findUnique.mockResolvedValue({ value: false });
    prisma.stagedWarehouse.create.mockImplementation(async ({ data }) => ({ ...data, id: '00000000-0000-4000-8000-000000000123' }));
    const fetch = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Maps unavailable'));
    try {
        const input = { ...body(), googleLocation: 'https://maps.app.goo.gl/ttMpsPTNwLcrdHas5' };
        await post('/api/warehouses').send(input).expect(201);
        expect(prisma.stagedWarehouse.create.mock.calls[0][0].data.googleLocation).toBe(input.googleLocation);
        expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
});
