const express = require('express');
const request = require('supertest');
const {
  randomUUID
} = require('node:crypto');
const {
  app: warehouseApp,
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
test('a viewer without Reviewer or Edit access can request the field markers', async () => {
  prisma.verifiedNumber.findFirst.mockResolvedValue(active({ editOwnWarehouseEntries: false, editAllWarehouseEntries: false }));
  const summaries = [{ warehouseId: 4821, activeCount: 1, activeFieldKeys: ['ratePerSqft'],
    activeFields: [{ fieldKey: 'ratePerSqft', comment: 'Confirm the rent.' }], canOpen: false, reviewId: null }];
  service.summaries.mockResolvedValue(summaries);
  const response = await auth(request(app).get(root + '/summaries')).query({ ids: '4821' }).expect(200);
  expect(response.body).toEqual({ success: true, data: summaries });
  expect(service.summaries).toHaveBeenCalledWith([4821], expect.objectContaining({ isReviewer: false, isAdmin: false }));
  expect(service.detail).not.toHaveBeenCalled();
});
test('queue filters use the dashboard vocabulary and bounded pagination', async () => {
  await auth(request(app).get(root)).query({
    view: 'previous', page: '2', limit: '100', search: '4821, 4822',
    state: 'Maharashtra', city: 'Bhiwandi', warehouseType: 'PEB',
    contactPerson: 'Owner', minArea: '25000', maxRate: '22.5',
    visibility: 'visible', fireNoc: 'available', landType: 'CLU',
    all: 'true'
  }).expect(200);
  expect(service.list).toHaveBeenCalledWith(expect.objectContaining({ email: 'user@wareongo.com' }), {
    view: 'previous', page: 2, limit: 100, search: '4821, 4822',
    state: 'Maharashtra', city: 'Bhiwandi', warehouseType: 'PEB',
    contactPerson: 'Owner', minArea: 25000, maxRate: 22.5,
    visibility: 'visible', fireNoc: 'available', landType: 'CLU'
  });
});
test.each([
  { minArea: '-1' }, { maxRate: 'not a number' }, { limit: '101' },
  { visibility: 'all' }, { fireNoc: 'Yes' },
  { search: Array.from({ length: 501 }, (_, i) => i + 1).join(',') }
])('invalid queue filters cannot reach the service: %j', async query => {
  await auth(request(app).get(root)).query(query).expect(400);
  expect(service.list).not.toHaveBeenCalled();
});
test('employees cannot create, decide, return, reopen or reassign', async () => {
  await auth(request(app).get(root + '/setup/4821')).expect(403);
  for (const path of ['', '/' + id + '/flags/' + flag + '/decision', '/' + id + '/flags/' + flag + '/return', '/' + id + '/flags/' + flag + '/reopen']) await auth(request(app).post(root + path)).send(body()).expect(403);
  await auth(request(app).patch(root + '/' + id + '/assignee')).send({
    assigneeId: 8
  }).expect(403);
  for (const method of ['setup', 'create', 'decide', 'returnForChanges', 'reopen', 'reassign']) {
    expect(service[method]).not.toHaveBeenCalled();
  }
});
test.each([
  ['reviewer', { reviewerAccess: true }],
  ['admin', { adminAccess: true }]
])('%s can flag, verify, return, reopen and reassign', async (_role, permissions) => {
  prisma.verifiedNumber.findFirst.mockResolvedValue(active(permissions));
  await auth(request(app).get(root + '/setup/4821')).expect(200);
  await auth(request(app).post(root)).send({
    requestId: randomUUID(), warehouseId: 4821, assigneeId: 8,
    fields: [{ key: 'ratePerSqft', comment: 'Confirm the rent.' }]
  }).expect(200);
  await auth(request(app).post(root + '/' + id + '/flags/' + flag + '/decision')).send({
    requestId: randomUUID(), version: 0, currentVersion: 0, choice: 'PROPOSED'
  }).expect(200);
  await auth(request(app).post(root + '/' + id + '/flags/' + flag + '/return')).send({
    requestId: randomUUID(), version: 0, comment: 'Please check again.'
  }).expect(200);
  await auth(request(app).post(root + '/' + id + '/flags/' + flag + '/reopen')).send({
    requestId: randomUUID(), version: 0
  }).expect(200);
  await auth(request(app).patch(root + '/' + id + '/assignee')).send({
    requestId: randomUUID(), version: 0, assigneeId: 8
  }).expect(200);
  for (const method of ['setup', 'create', 'decide', 'returnForChanges', 'reopen', 'reassign']) {
    expect(service[method]).toHaveBeenCalledTimes(1);
    expect(service[method].mock.calls[0].at(-1)).toMatchObject({
      email: 'user@wareongo.com', isReviewer: true, isAdmin: !!permissions.adminAccess
    });
  }
});
test('revoking reviewer access blocks the next management request', async () => {
  prisma.verifiedNumber.findFirst.mockResolvedValue(active({ reviewerAccess: true }));
  await auth(request(app).get(root + '/setup/4821')).expect(200);
  prisma.verifiedNumber.findFirst.mockResolvedValue(active());
  await auth(request(app).post(root)).send({
    requestId: randomUUID(), warehouseId: 4821,
    fields: [{ key: 'ratePerSqft', comment: 'Confirm the rent.' }]
  }).expect(403);
  expect(service.create).not.toHaveBeenCalled();
});
test.each([false, true])('setup observes a cross-instance reviewer change while the cached grant is %s', async previousGrant => {
  const { resolveCapabilities } = require('../../src/utils/access');
  prisma.verifiedNumber.findFirst.mockResolvedValue(active({ reviewerAccess: previousGrant }));
  expect((await resolveCapabilities('user@wareongo.com')).REVIEW).toBe(previousGrant);
  // Updating a different API instance does not invalidate this process's cache.
  prisma.verifiedNumber.findFirst.mockResolvedValue(active({ reviewerAccess: !previousGrant }));
  await auth(request(app).get(root + '/setup/4821')).expect(previousGrant ? 403 : 200);
  if (previousGrant) expect(service.setup).not.toHaveBeenCalled();
  else expect(service.setup).toHaveBeenCalledWith(4821, expect.objectContaining({ isReviewer: true }));
});
test('reviewer permission alone does not grant dashboard or field-review access', async () => {
  prisma.verifiedNumber.findFirst.mockResolvedValue(active({
    dashboardAccess: false,
    reviewerAccess: true
  }));
  await auth(request(app).get(root)).expect(403);
  await auth(request(app).get(root + '/setup/4821')).expect(403);
  await auth(request(app).post(root)).send({}).expect(403);
  expect(service.list).not.toHaveBeenCalled();
  expect(service.setup).not.toHaveBeenCalled();
  expect(service.create).not.toHaveBeenCalled();
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
test('read-only employees can submit review responses without receiving ordinary warehouse Edit access', async () => {
  prisma.verifiedNumber.findFirst.mockResolvedValue(active({
    editOwnWarehouseEntries: false, editAllWarehouseEntries: false,
  }));
  const data = body();
  await auth(request(app).post(root + '/' + id + '/flags/' + flag + '/response')).send(data).expect(200);
  expect(service.respond).toHaveBeenCalledWith(id, flag, data, expect.objectContaining({
    capabilities: expect.objectContaining({ WAREHOUSE_EDIT_OWN: false, WAREHOUSE_EDIT_ALL: false }),
  }));
  await auth(request(warehouseApp).put('/api/warehouses/4821')).send({ ratePerSqft: '24' }).expect(403);
  expect(prisma.warehouse.update).not.toHaveBeenCalled();
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
