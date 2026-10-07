const express = require('express');
const request = require('supertest');
const WarehouseController = require('../../src/controllers/warehouseController');
const WarehouseService = require('../../src/services/warehouseService');
const Validation = require('../../src/middleware/validation');
const ErrorHandler = require('../../src/middleware/errorHandler');
const createAuditMiddleware = require('../../src/middleware/auditMiddleware');

function fixture() {
    let row = { id: 7, availability: 'Yes', availabilityLastReviewedOn: new Date('2025-01-01T00:00:00.000Z'), WarehouseData: {} };
    const captured = [];
    const model = { findById: async () => row, update: jest.fn(async (_id, data) => (row = { ...row, ...data })) };
    const controller = new WarehouseController(new WarehouseService(model), {});
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 1, email: 'fixture@example.test' }; next(); });
    app.use(createAuditMiddleware({ log: async entry => captured.push(entry) }));
    app.put('/warehouses/:id', Validation.validateWarehouseUpdate, controller.updateWarehouse);
    app.use(ErrorHandler.handle);
    return { app, model, captured };
}

test('HTTP validation preserves the snapshot across both validation passes and audits the review', async () => {
    const { app, model, captured } = fixture();
    const res = await request(app).put('/warehouses/7').send({
        availabilityLastReviewedOn: '2025-01-02',
        expectedAvailability: { availability: 'Yes', availabilityLastReviewedOn: '2025-01-01' },
    });
    expect(res.status).toBe(200);
    expect(res.body.availabilityLastReviewedOn).toBe('2025-01-02T00:00:00.000Z');
    expect(model.update.mock.calls[0][2]).toMatchObject({ availability: 'Yes' });
    expect(model.update.mock.calls[0][1]).not.toHaveProperty('expectedAvailability');
    await new Promise(resolve => setImmediate(resolve));
    expect(captured[0]).toMatchObject({ userEmail: 'fixture@example.test',
        metadata: { changes: [{ field: 'availabilityLastReviewedOn', from: '2025-01-01T00:00:00.000Z', to: '2025-01-02T00:00:00.000Z' }] } });
});

test('a stale review returns a usable 409 and writes nothing', async () => {
    const { app, model } = fixture();
    const res = await request(app).put('/warehouses/7').send({ availabilityLastReviewedOn: '2025-01-02',
        expectedAvailability: { availability: 'No', availabilityLastReviewedOn: '2025-01-01' } });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'AVAILABILITY_CONFLICT' });
    expect(res.body.error).toContain('Refresh the list');
    expect(model.update).not.toHaveBeenCalled();
});

test.each(['2025-02-30', '9999-01-01'])('invalid review %s returns field-level validation and writes nothing', async value => {
    const { app, model } = fixture();
    const res = await request(app).put('/warehouses/7').send({ availabilityLastReviewedOn: value });
    expect(res.status).toBe(400);
    expect(res.body.details.issues[0].path).toContain('availabilityLastReviewedOn');
    expect(model.update).not.toHaveBeenCalled();
});
