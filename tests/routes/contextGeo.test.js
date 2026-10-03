const express = require('express');
const request = require('supertest');
const { fixture } = require('../fixtures/contextGeo');
const createRouter = require('../../src/routes/contextGeo');
const { PATH, ContextGeoError } = require('../../src/utils/contextGeoAuth');

function setup() {
    const f = fixture(), app = express();
    const service = { create: jest.fn(async () => ({ operationId: f.point.operationId, replayed: false, data: { id: 'synthetic-poi' } })) };
    app.use(PATH, createRouter({ service, env: f.env, now: () => f.now }));
    app.use(express.json());
    return { ...f, app, service };
}
const post = (f, req = f.request()) => request(f.app).post(PATH).set(req.headers).send(req.body.toString());
test('raw signed Unicode and HTML-looking notes reach the strict service unchanged', async () => {
    const f = setup(), point = { ...f.point, notes: 'कृपया <gate> & access details' };
    const response = await post(f, f.request(point)).expect(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(f.service.create.mock.calls[0][0]).toEqual(point);
});
test('duplicate result is 200 and recognized idempotency conflict is 409', async () => {
    const f = setup();
    f.service.create.mockResolvedValueOnce({ replayed: true, operationId: f.point.operationId, data: { id: 'original' } });
    expect((await post(f).expect(200)).body.data.id).toBe('original');
    f.service.create.mockRejectedValueOnce(new ContextGeoError(409, 'CONTEXT_GEO_IDEMPOTENCY_CONFLICT'));
    expect((await post(f).expect(409)).body.code).toBe('CONTEXT_GEO_IDEMPOTENCY_CONFLICT');
});
test('disabled gate and invalid signatures never invoke the service', async () => {
    const f = setup();
    await request(f.app).post(PATH).send(f.point).expect(401);
    f.env.WAG_CONTEXT_GEO_ENABLED = 'false';
    await post(f).expect(503);
    expect(f.service.create).not.toHaveBeenCalled();
});
test('rejects oversized and malformed JSON without reflecting it, and hides database errors', async () => {
    const f = setup();
    await post(f, f.request(undefined, { serialized: 'x'.repeat(32769) })).expect(413);
    expect((await post(f, f.request(undefined, { serialized: '{secret_bad_json' })).expect(400)).text).not.toContain('secret_bad_json');
    f.service.create.mockRejectedValue(new Error('postgres://secret plus private notes'));
    expect((await post(f).expect(503)).text).not.toContain('secret');
});
