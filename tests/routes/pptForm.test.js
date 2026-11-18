// Rate limiting has its own tests; exercise every field through both real routers.
jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());
const request = require('supertest');
const { app, prisma, reset, active, tokenFor } = require('../helpers/app');
const { completePptForm, requiredPaths, patchForPath } = require('../fixtures/pptForm');
const { pptFormSnapshot, flatFormValues } = require('../../src/utils/pptFormPolicy');

beforeEach(() => {
    reset();
    prisma.verifiedNumber.findFirst.mockResolvedValue(active());
    prisma.verifiedNumber.findUnique.mockResolvedValue(active());
    prisma.appSetting.findUnique.mockResolvedValue({ value: false });
    prisma.stagedWarehouse.create.mockImplementation(async ({ data }) => ({ ...data, id: '00000000-0000-4000-8000-000000000123' }));
});
describe.each(['/api/warehouses', '/api/warehouses/scout'])('%s PPT requirements', route => {
    const post = data => request(app).post(route).set('Authorization', `Bearer ${tokenFor()}`).send(data);
    test.each(requiredPaths)('rejects omitted, null and whitespace %s before storage', async path => {
        for (const value of [undefined, null, ' ']) {
            const original = completePptForm(), patch = patchForPath(path, value);
            const payload = { ...original, ...patch, warehouseData: { ...original.warehouseData, ...patch.warehouseData } };
            const response = await post(payload).expect(400);
            expect(response.body.details.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: path.split('.') })]));
        }
        expect(prisma.stagedWarehouse.create).not.toHaveBeenCalled();
    });
    test('complete answers preserve zero, false and explicit None through staging', async () => {
        await post(completePptForm()).expect(201);
        expect(prisma.stagedWarehouse.create.mock.calls[0][0].data).toMatchObject({
            numberOfDocks: '0', fireNocAvailable: false, plinthHeightFt: '0 feet', canopyType: 'None',
            ventilationType: 'None', powerKva: 'As per requirement', washroom_count: 'Male: 0; Female: 0',
        });
    });
    test('handover must include timing for its chosen mode', async () => {
        await post({ ...completePptForm(), handoverDate: null }).expect(400);
        await post({ ...completePptForm(), handoverType: 'VARIABLE', handoverLeadValue: 2 }).expect(400);
        await post({ ...completePptForm(), handoverType: 'VARIABLE', handoverLeadValue: 2, handoverLeadUnit: 'WEEKS' }).expect(201);
    });
    test('read-shaped or flattened properties cannot satisfy missing nested writable answers', async () => {
        const full = completePptForm();
        for (const forged of [{ ...full.warehouseData }, { WarehouseData: full.warehouseData }]) {
            const response = await post({ ...full, ...forged, warehouseData: {} }).expect(400);
            expect(response.body.details.issues).toEqual(expect.arrayContaining([
                expect.objectContaining({ path: ['warehouseData', 'fireNocAvailable'] }),
                expect.objectContaining({ path: ['warehouseData', 'powerKva'] }),
            ]));
        }
        expect(prisma.stagedWarehouse.create).not.toHaveBeenCalled();
    });
    test.each([undefined, 'false'])('obsolete rollout flags cannot disable new-form requirements (%s)', async flag => {
        const names = ['PPT_V3_FORM_REQUIREMENTS_ENFORCED', 'WAREHOUSE_FORM_REQUIREMENTS_ENFORCED'];
        const previous = names.map(name => process.env[name]);
        try {
            for (const name of names) { if (flag === undefined) delete process.env[name]; else process.env[name] = flag; }
            const payload = completePptForm(); delete payload.clearHeightFt;
            await post(payload).expect(400);
            expect(prisma.stagedWarehouse.create).not.toHaveBeenCalled();
        } finally {
            names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
        }
    });
});

test('a raced form save returns an actionable 409 rather than a server error', async () => {
    const express = require('express'), { formConflict } = require('../../src/utils/formChanges');
    const endpoint = express();
    endpoint.put('/save', (_req, _res, next) => next(formConflict()));
    endpoint.use(require('../../src/middleware/errorHandler').handle);
    const response = await request(endpoint).put('/save').expect(409);
    expect(response.body).toMatchObject({ code: 'FORM_FIELDS_CHANGED' });
});

describe.each([false, true])('edit snapshot HTTP contract (staged=%s)', pending => {
    const id = pending ? '00000000-0000-4000-8000-000000000123' : 123;
    const edit = data => request(app)[pending ? 'patch' : 'put'](`/api/${pending ? 'staging' : 'warehouses'}/${id}`)
        .set('Authorization', `Bearer ${tokenFor()}`).send(data);
    beforeEach(() => {
        prisma.verifiedNumber.findFirst.mockResolvedValue(active({ reviewerAccess: true }));
        prisma.verifiedNumber.findUnique.mockResolvedValue(active({ reviewerAccess: true }));
        const fixture = completePptForm();
        const row = pending ? { ...flatFormValues(fixture), id, reviewStatus: 'PENDING', powerKva: '200 kVA' }
            : { ...fixture, id, WarehouseData: { ...fixture.warehouseData, powerKva: '200 kVA' } };
        delete row.warehouseData;
        prisma[pending ? 'stagedWarehouse' : 'warehouse'].findUnique.mockResolvedValue(row);
    });
    test('a missing baseline returns a refresh conflict without writing', async () => {
        const response = await edit({ warehouseData: { powerKva: '300 kVA' } }).expect(409);
        expect(response.body).toMatchObject({ code: 'FORM_FIELDS_CHANGED', error: expect.stringMatching(/original answers are missing/) });
        expect(prisma[pending ? 'stagedWarehouse' : 'warehouse'].update).not.toHaveBeenCalled();
    });
    test('a stale intentional edit returns the same actionable conflict code', async () => {
        const response = await edit({ warehouseData: { powerKva: '300 kVA' }, expectedFormValues: pptFormSnapshot(completePptForm()) }).expect(409);
        expect(response.body).toMatchObject({ code: 'FORM_FIELDS_CHANGED', error: expect.stringMatching(/changed while this form was open/) });
        expect(prisma[pending ? 'stagedWarehouse' : 'warehouse'].update).not.toHaveBeenCalled();
    });
    test('predicate objects in a snapshot are rejected before storage', async () => {
        await edit({ warehouseData: { powerKva: '300 kVA' },
            expectedFormValues: { ...pptFormSnapshot(completePptForm()), powerKva: { not: null } } }).expect(400);
        expect(prisma[pending ? 'stagedWarehouse' : 'warehouse'].update).not.toHaveBeenCalled();
    });
});
