const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { prisma, reset, tokenFor, active } = require('../helpers/app');
const { createRouter } = require('../../src/routes/warehouseQa');
const { QaError } = require('../../src/warehouseQa/common');
const methods = [
  'config',
  'summary',
  'runs',
  'create',
  'cron',
  'status',
  'processRun',
  'list',
  'reviewers',
  'detail',
  'export',
  'mutate'
];
const service = Object.fromEntries(methods.map((method) => [method, jest.fn()]));
const app = express();
app.use(express.json());
app.use(
  '/api/ai-qa',
  createRouter({
    getService: () => service,
    cronSecret: () => 'fixture-cron-secret-with-at-least-32-characters'
  })
);
const root = '/api/ai-qa';
const auth = (call) => call.set('Authorization', 'Bearer ' + tokenFor());
beforeEach(() => {
  reset();
  Object.values(service).forEach((fn) => fn.mockReset().mockResolvedValue({}));
  prisma.verifiedNumber.findFirst.mockResolvedValue(active({ adminAccess: true }));
});
test('all review data requires a freshly authorized admin', async () => {
  await request(app)
    .get(root + '/runs')
    .expect(401);
  await auth(request(app).get(root + '/runs')).expect(200);
  prisma.verifiedNumber.findFirst.mockResolvedValue(active({ adminAccess: false, reviewerAccess: true }));
  await auth(request(app).get(root + '/runs')).expect(403);
  expect(service.runs).toHaveBeenCalledTimes(1);
});

test('previous evaluations use the same authenticated paginated queue contract', async () => {
  await auth(request(app).get(root + '/runs/inbox/warehouses'))
    .query({ stage: 'SUPERSEDED' })
    .expect(200);
  expect(service.list).toHaveBeenCalledWith('inbox', { page: 1, limit: 20, stage: 'SUPERSEDED', search: '' });
});
test('AI queue and summary validate the admin identity and suggestions require fresh admin access', async () => {
  const reviewerEmail = 'other@wareongo.com';
  await auth(request(app).get(root + '/runs/inbox/warehouses')).query({ stage: 'DISMISSED', reviewerEmail: ` ${reviewerEmail} ` }).expect(200);
  expect(service.list).toHaveBeenCalledWith('inbox', { page: 1, limit: 20, stage: 'DISMISSED', search: '', reviewerEmail });
  await auth(request(app).get(root + '/summary')).query({ reviewerEmail }).expect(200);
  expect(service.summary).toHaveBeenCalledWith({ reviewerEmail });
  for (const path of ['/runs/inbox/warehouses', '/summary']) {
    await auth(request(app).get(root + path)).query({ reviewerEmail: 'invalid' }).expect(400);
    await auth(request(app).get(root + path)).query({ reviewerEmail: [reviewerEmail, 'b@wareongo.com'] }).expect(400);
  }
  await request(app).get(root + '/runs/inbox/reviewers').expect(401);
  await auth(request(app).get(root + '/runs/inbox/reviewers')).expect(200);
  expect(service.reviewers).toHaveBeenCalledWith('inbox');
  prisma.verifiedNumber.findFirst.mockResolvedValue(active({ adminAccess: false, reviewerAccess: true }));
  await auth(request(app).get(root + '/runs/inbox/reviewers')).expect(403);
  expect(service.reviewers).toHaveBeenCalledTimes(1);
});
test('cron token only authorizes the cron endpoint', async () => {
  const body = { request_id: randomUUID(), warehouse_ids: [1] };
  await auth(request(app).post(root + '/cron'))
    .send(body)
    .expect(401);
  await request(app)
    .post(root + '/cron')
    .set('X-AI-QA-Token', 'wrong')
    .send(body)
    .expect(401);
  await request(app)
    .post(root + '/cron')
    .set('X-AI-QA-Token', 'fixture-cron-secret-with-at-least-32-characters')
    .send(body)
    .expect(200);
  await request(app)
    .get(root + '/runs')
    .set('X-AI-QA-Token', 'fixture-cron-secret-with-at-least-32-characters')
    .expect(401);
  expect(service.cron).toHaveBeenCalledTimes(1);
});
test.each([
  { warehouse_ids: [1, 1] },
  { warehouse_ids: [] },
  { model: 'other' },
  { actor: 'forged' },
  { warehouse_ids: [0] }
])('rejects invalid batch input %j', (overrides) => {
  return auth(request(app).post(root + '/runs'))
    .send({ request_id: randomUUID(), warehouse_ids: [1], ...overrides })
    .expect(400);
});
test('a valid batch passes only the authenticated actor and validated data', async () => {
  const id = randomUUID();
  await auth(request(app).post(root + '/runs'))
    .send({ request_id: id, warehouse_ids: [1, 2] })
    .expect(202);
  expect(service.create).toHaveBeenCalledWith(
    expect.objectContaining({ request_id: id, mode: 'BACKFILL', model: 'gpt-6.2-sol' }),
    expect.objectContaining({ email: 'user@wareongo.com', isAdmin: true })
  );
});

test('duplicate warehouse admission returns a readable conflict through the existing error contract', async () => {
  const message = 'WH603 is already in the QA/review pipeline. No new batch was created.';
  service.create.mockRejectedValue(new QaError(409, 'QA_WAREHOUSE_IN_PIPELINE', message));
  const response = await auth(request(app).post(root + '/runs'))
    .send({ request_id: randomUUID(), warehouse_ids: [603, 1065] })
    .expect(409);
  expect(response.body).toEqual({ success: false, error: { code: 'QA_WAREHOUSE_IN_PIPELINE', message } });
});

test('manual processing requires fresh admin access, accepts no extra input and cannot enqueue work', async () => {
  const path = root + '/runs/manual-run/process';
  await request(app).post(path).send({}).expect(401);
  await request(app)
    .post(path)
    .set('X-AI-QA-Token', 'fixture-cron-secret-with-at-least-32-characters')
    .send({})
    .expect(401);
  await auth(request(app).post(path))
    .send({ warehouse_ids: [1] })
    .expect(400);
  await auth(request(app).post(path)).send({}).expect(200);
  expect(service.processRun).toHaveBeenCalledWith('manual-run');
  expect(service.create).not.toHaveBeenCalled();
  prisma.verifiedNumber.findFirst.mockResolvedValue(active({ adminAccess: false, reviewerAccess: true }));
  await auth(request(app).post(path)).send({}).expect(403);
  expect(service.processRun).toHaveBeenCalledTimes(1);
});

test('cron monitoring and bounded draining need the service token and never grant review access', async () => {
  service.health = jest.fn().mockResolvedValue({ ready: true });
  service.drain = jest.fn().mockResolvedValue({ ready: true });
  const token = 'fixture-cron-secret-with-at-least-32-characters';
  await request(app)
    .get(root + '/cron/health')
    .expect(401);
  await auth(request(app).post(root + '/cron/drain'))
    .send({})
    .expect(401);
  await request(app)
    .get(root + '/cron/health')
    .set('X-AI-QA-Token', token)
    .expect(200);
  await request(app)
    .post(root + '/cron/drain')
    .set('X-AI-QA-Token', token)
    .send({})
    .expect(200);
  await request(app)
    .post(root + '/cron/drain')
    .set('X-AI-QA-Token', token)
    .send({ assignee_id: 2 })
    .expect(400);
  await auth(request(app).get(root + '/health')).expect(200);
  expect(service.drain).toHaveBeenCalledTimes(1);
});
