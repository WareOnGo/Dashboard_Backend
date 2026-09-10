const express = require('express');
const request = require('supertest');
const mockService = { sweep: jest.fn() };
jest.mock('../../src/container', () => ({ resolve: () => mockService }));
const router = require('../../src/routes/enrichment');
const app = express();
app.use(express.json());
app.use('/api/enrichment', router);
const oldSecret = process.env.CRON_SECRET;
beforeEach(() => { jest.clearAllMocks(); process.env.CRON_SECRET = 'test-only-secret'; });
afterAll(() => { if (oldSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = oldSecret; });

test('rejects missing/incorrect cron authentication without running enrichment', async () => {
    await request(app).post('/api/enrichment/sweep').send({}).expect(401);
    await request(app).post('/api/enrichment/sweep').set('x-webhook-secret', 'wrong').send({}).expect(401);
    expect(mockService.sweep).not.toHaveBeenCalled();
});
test('fails closed if the cron secret is absent', async () => {
    delete process.env.CRON_SECRET;
    await request(app).post('/api/enrichment/sweep').send({}).expect(503);
});
test('accepts a dry run and passes the boolean without starting paid work', async () => {
    mockService.sweep.mockResolvedValue({ status: 'DRY_RUN' });
    await request(app).post('/api/enrichment/sweep').set('x-webhook-secret', 'test-only-secret')
        .send({ dryRun: true }).expect(200);
    expect(mockService.sweep).toHaveBeenCalledWith({ dryRun: true });
});
test.each([{ dryRun: 'false' }, { limit: 5000 }, { model: 'unexpected' }])('rejects unsafe/ambiguous options %p', async body => {
    await request(app).post('/api/enrichment/sweep').set('x-webhook-secret', 'test-only-secret').send(body).expect(400);
    expect(mockService.sweep).not.toHaveBeenCalled();
});
test.each(['FAILED', 'PARTIAL'])('reports %s as a failing HTTP outcome for pg_net monitoring', async status => {
    mockService.sweep.mockResolvedValue({ status, stages: {} });
    const response = await request(app).post('/api/enrichment/sweep').set('x-webhook-secret', 'test-only-secret').send({}).expect(503);
    expect(response.body.success).toBe(false);
});
test('normal overlap remains HTTP 200', async () => {
    mockService.sweep.mockResolvedValue({ status: 'SKIPPED' });
    await request(app).post('/api/enrichment/sweep').set('x-webhook-secret', 'test-only-secret').send({}).expect(200);
});
