const request = require('supertest');
const { app, prisma, reset, active } = require('../helpers/app');
const { completePptForm } = require('../fixtures/pptForm');

beforeEach(() => { reset(); prisma.verifiedNumber.findUnique.mockResolvedValue(active()); });

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
    await request(app).post('/api/warehouses/scout').send({ ...completePptForm(), warehouseData: {} }).expect(400);
    const response = await request(app).post('/api/warehouses/scout').send({ ...completePptForm(),
        googleLocation: ' ' }).expect(400);
    expect(response.body.details.issues[0].path).toEqual(['googleLocation']);
    expect(prisma.stagedWarehouse.create).not.toHaveBeenCalled();
});

test('older Scout clients cannot create a new warehouse with missing answers', async () => {
    await request(app).post('/api/warehouses/scout').send({
        uploadedBy: 'QA1234', warehouseType: 'PEB', address: 'Older open form', city: 'New Delhi', state: 'Delhi',
        contactPerson: 'Owner', contactNumber: '9876543210', totalSpaceSqft: [10000], compliances: 'CLU', ratePerSqft: '25',
        warehouseData: {},
    }).expect(400);
    expect(prisma.stagedWarehouse.create).not.toHaveBeenCalled();
});


test('Scout submits short Maps links without a network check', async () => {
    prisma.appSetting.findUnique.mockResolvedValue({ value: false });
    prisma.stagedWarehouse.create.mockImplementation(async ({ data }) => ({ ...data, id: '00000000-0000-4000-8000-000000000123' }));
    const fetch = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Maps unavailable'));
    try {
        await request(app).post('/api/warehouses/scout').send({
            ...completePptForm(), googleLocation: 'https://maps.app.goo.gl/ttMpsPTNwLcrdHas5',
        }).expect(201);
        expect(prisma.stagedWarehouse.create.mock.calls[0][0].data.googleLocation).toBe('https://maps.app.goo.gl/ttMpsPTNwLcrdHas5');
        expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
});
