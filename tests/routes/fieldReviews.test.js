const express = require('express');
const request = require('supertest');
const {
  randomUUID
} = require('node:crypto');
const {
  prisma,
  reset,
  tokenFor,
  active
} = require('../helpers/app');
const {
  createRouter
} = require('../../src/routes/fieldReviews');
const {
  ReviewError
} = require('../../src/fieldReview/service');
const methods = ['setup', 'list', 'detail', 'create', 'respond', 'decide', 'returnForChanges', 'reopen', 'reassign', 'history', 'reveal', 'summaries', 'events'];
const service = Object.fromEntries(methods.map(name => [name, jest.fn().mockResolvedValue({})]));
const app = express();
app.use(express.json());
app.use('/api/field-reviews', createRouter(service));
const root = '/api/field-reviews';
const id = randomUUID(),
  flag = randomUUID();
const body = () => ({
  requestId: randomUUID(),
  version: 0,
  baselineVersion: 0,
  resolution: 'NO_CHANGE',
  explanation: 'Confirmed with owner.'
});
const auth = call => call.set('Authorization', 'Bearer ' + tokenFor());
beforeEach(() => {
  reset();
  Object.values(service).forEach(fn => fn.mockReset().mockResolvedValue({}));
  prisma.verifiedNumber.findFirst.mockResolvedValue(active());
});
test('requires JWT before any field-review service call', async () => {
  await request(app).get(root).expect(401);
  expect(service.list).not.toHaveBeenCalled();
});
test('employees cannot create, decide, return, reopen or reassign', async () => {
  for (const path of ['', '/' + id + '/flags/' + flag + '/decision', '/' + id + '/flags/' + flag + '/return', '/' + id + '/flags/' + flag + '/reopen']) await auth(request(app).post(root + path)).send(body()).expect(403);
  await auth(request(app).patch(root + '/' + id + '/assignee')).send({
    assigneeId: 8
  }).expect(403);
  expect(service.decide).not.toHaveBeenCalled();
});
test('reviewer permission alone does not grant dashboard or field-review access', async () => {
  prisma.verifiedNumber.findFirst.mockResolvedValue(active({
    dashboardAccess: false,
    reviewerAccess: true
  }));
  await auth(request(app).get(root)).expect(403);
  expect(service.list).not.toHaveBeenCalled();
});
test.each(['REJECT', 'ACCEPT', 'APPROVE'])('removed employee action %s is rejected', async resolution => {
  await auth(request(app).post(root + '/' + id + '/flags/' + flag + '/response')).send({
    ...body(),
    resolution
  }).expect(400);
  expect(service.respond).not.toHaveBeenCalled();
});
test.each([{
  explanation: ' '
}, {
  version: -1
}, {
  baselineVersion: undefined
}, {
  assigneeId: 2
}, {
  currentValue: 'forged'
}])('invalid response %j cannot reach the service', async override => {
  await auth(request(app).post(root + '/' + id + '/flags/' + flag + '/response')).send({
    ...body(),
    ...override
  }).expect(400);
  expect(service.respond).not.toHaveBeenCalled();
});
test('valid response passes the authenticated identity and typed payload only', async () => {
  const data = body();
  await auth(request(app).post(root + '/' + id + '/flags/' + flag + '/response')).send(data).expect(200);
  expect(service.respond).toHaveBeenCalledWith(id, flag, data, expect.objectContaining({
    email: 'user@wareongo.com'
  }));
});
test('returns an actionable conflict without an internal exception or 500', async () => {
  prisma.verifiedNumber.findFirst.mockResolvedValue(active({
    adminAccess: true
  }));
  service.decide.mockRejectedValue(new ReviewError(409, 'CURRENT_CHANGED', 'Review the refreshed comparison.'));
  const result = await auth(request(app).post(root + '/' + id + '/flags/' + flag + '/decision')).send({
    requestId: randomUUID(),
    version: 1,
    currentVersion: 2,
    choice: 'CURRENT'
  }).expect(409);
  expect(result.body.error).toEqual({
    code: 'CURRENT_CHANGED',
    message: 'Review the refreshed comparison.'
  });
});
test('admin creation rejects generated fields and oversized comments', async () => {
  prisma.verifiedNumber.findFirst.mockResolvedValue(active({
    adminAccess: true
  }));
  for (const fields of [[{
    key: 'id',
    comment: 'Check'
  }], [{
    key: 'ratePerSqft',
    comment: 'a'.repeat(501)
  }]]) await auth(request(app).post(root)).send({
    requestId: randomUUID(),
    warehouseId: 4821,
    fields
  }).expect(400);
  expect(service.create).not.toHaveBeenCalled();
});
