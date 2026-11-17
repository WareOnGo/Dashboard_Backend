const request = require('supertest');
const { app, prisma, reset, active } = require('../helpers/app');

beforeEach(() => { delete process.env.WAREHOUSE_FORM_REQUIREMENTS_ENFORCED; reset(); prisma.verifiedNumber.findUnique.mockResolvedValue(active()); });
afterEach(() => { delete process.env.WAREHOUSE_FORM_REQUIREMENTS_ENFORCED; });

test('location checks require an active Scout Employee ID', async () => {
    await request(app).post('/api/warehouses/scout/resolve-location').send({ googleLocation: 'https://www.google.com/maps?q=12,77' }).expect(401);
    expect(prisma.verifiedNumber.findUnique).not.toHaveBeenCalled();
    prisma.verifiedNumber.findUnique.mockResolvedValue(active({ is_active: false }));
    await request(app).post('/api/warehouses/scout/resolve-location').send({ uploadedBy: 'QA1234', googleLocation: 'https://www.google.com/maps?q=12,77' }).expect(403);
});

test('the production resolver returns coordinates without storing a submission', async () => {
    const response = await request(app).post('/api/warehouses/scout/resolve-location')
        .send({ uploadedBy: 'QA1234', googleLocation: 'https://www.google.com/maps?q=12,77' }).expect(200);
    expect(response.body).toMatchObject({ latitude: 12, longitude: 77 });
    expect(prisma.stagedWarehouse.create).not.toHaveBeenCalled();
});

test('missing land type and an empty location are rejected before storing a submission', async () => {
    process.env.WAREHOUSE_FORM_REQUIREMENTS_ENFORCED = 'true';
    await request(app).post('/api/warehouses/scout').send({ uploadedBy: 'QA1234', googleLocation: 'https://www.google.com/maps?q=12,77' }).expect(400);
    const response = await request(app).post('/api/warehouses/scout').send({ uploadedBy: 'QA1234',
        warehouseData: { landType: 'Warehouse CLU', latitude: 12, longitude: 77 },
        googleLocation: ' ' }).expect(400);
    expect(response.body.details.issues[0].path).toEqual(['googleLocation']);
    expect(prisma.stagedWarehouse.create).not.toHaveBeenCalled();
});

test.each([undefined, 'false'])('older Scout submissions still save during rollout (enforcement=%s)', async enforcement => {
    if (enforcement) process.env.WAREHOUSE_FORM_REQUIREMENTS_ENFORCED = enforcement;
    prisma.appSetting.findUnique.mockResolvedValue({ value: false });
    prisma.stagedWarehouse.create.mockImplementation(async ({ data }) => ({ ...data, id: '00000000-0000-4000-8000-000000000123' }));
    await request(app).post('/api/warehouses/scout').send({
        uploadedBy: 'QA1234', warehouseType: 'PEB', address: 'Older open form', city: 'New Delhi', state: 'Delhi',
        contactPerson: 'Owner', contactNumber: '9876543210', totalSpaceSqft: [10000], compliances: 'CLU', ratePerSqft: '25',
        warehouseData: {},
    }).expect(201);
    const saved = prisma.stagedWarehouse.create.mock.calls[0][0].data;
    expect(saved.landType ?? null).toBeNull();
    expect(saved.googleLocation ?? null).toBeNull();
});


test('Scout submits short Maps links without a network check', async () => {
    prisma.appSetting.findUnique.mockResolvedValue({ value: false });
    prisma.stagedWarehouse.create.mockImplementation(async ({ data }) => ({ ...data, id: '00000000-0000-4000-8000-000000000123' }));
    const fetch = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Maps unavailable'));
    try {
        await request(app).post('/api/warehouses/scout').send({
            uploadedBy: 'QA1234', warehouseType: 'PEB', address: 'Locality', city: 'New Delhi', state: 'Delhi',
            contactPerson: 'Owner', contactNumber: '9876543210', totalSpaceSqft: [10000], compliances: 'CLU', ratePerSqft: '25',
            googleLocation: 'https://maps.app.goo.gl/ttMpsPTNwLcrdHas5', warehouseData: { landType: 'Warehouse CLU' },
        }).expect(201);
        expect(prisma.stagedWarehouse.create.mock.calls[0][0].data.googleLocation).toBe('https://maps.app.goo.gl/ttMpsPTNwLcrdHas5');
        expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
});
