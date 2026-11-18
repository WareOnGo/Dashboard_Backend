const request = require('supertest');
const { Prisma } = require('@prisma/client');
const { app, prisma, reset, tokenFor, active } = require('../helpers/app');
const warehouse = { id: 123, city: 'Indore', contactNumber: '919800000001', WarehouseData: {} };

beforeEach(() => {
  reset();
  prisma.verifiedNumber.findFirst.mockResolvedValue(active());
});
const authorized = path => request(app).get(path).set('Authorization', `Bearer ${tokenFor()}`);

test('production list applies pagination and filters and redacts contact data', async () => {
  prisma.warehouse.findMany.mockResolvedValue([warehouse]);
  prisma.warehouse.count.mockResolvedValue(15);
  const { body } = await authorized('/api/warehouses?page=2&limit=10&city=Indore').expect(200);
  expect(JSON.stringify(body)).not.toContain(warehouse.contactNumber);
  expect(prisma.warehouse.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 10 }));
  const where = prisma.warehouse.findMany.mock.calls[0][0].where;
  expect(prisma.warehouse.findMany.mock.calls[0][0].include).not.toHaveProperty('WarehouseProximity');
  expect(JSON.stringify(where)).toContain('Indore');
  expect(prisma.warehouse.count).toHaveBeenCalledWith({ where });
});

test.each(['9800000001', '+91 (98000) 00001', '0091 98000-00001'])(
  'production list accepts mobile search %s without revealing the contact', async search => {
    // First read: the slim search projection; second: the page rows by id.
    prisma.warehouse.findMany.mockResolvedValue([warehouse]);
    const { body } = await authorized('/api/warehouses').query({ search }).expect(200);
    expect(body.data.map(row => row.id)).toEqual([warehouse.id]);
    expect(body.data[0]).not.toHaveProperty('contactNumber');
    expect(JSON.stringify(body)).not.toContain(warehouse.contactNumber);
    expect(body.pagination.total).toBe(1);
    expect(body).not.toHaveProperty('search');
    const [candidates, page] = prisma.warehouse.findMany.mock.calls.map(([args]) => args);
    expect(candidates.select).toMatchObject({ contactNumber: true, alt_phone_number: true });
    expect(page.where).toEqual({ id: { in: [warehouse.id] } });
    // The search text never reaches SQL.
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.warehouse.count).not.toHaveBeenCalled();
  },
);
test('production detail reads saved proximity and redacts contact data', async () => {
  const proximity = [{ category: 'aerodrome', status: 'OK', landmarkName: 'Indore Airport', roadKm: 24.6, driveMinutes: 35 }];
  prisma.warehouse.findUnique.mockResolvedValue({ ...warehouse, WarehouseProximity: proximity });
  const { body } = await authorized('/api/warehouses/123').expect(200);
  expect(body.id).toBe(123);
  expect(body).not.toHaveProperty('contactNumber');
  expect(body.WarehouseProximity).toEqual(proximity);
  const query = prisma.warehouse.findUnique.mock.calls[0][0];
  expect(query.where).toEqual({ id: 123 });
  expect(query.include.WarehouseData).toBe(true);
  expect(query.include.WarehouseProximity.select).toMatchObject({ category: true, roadKm: true, driveMinutes: true });
  expect(query.include.WarehouseProximity.select).not.toHaveProperty('lastError');
});
test.each(['invalid-id', '123junk', '-1', '0', '1.5', '1e2', '2147483648', '9007199254740993'])
  ('invalid id %s returns 400 before querying warehouses', async id => {
    await authorized(`/api/warehouses/${id}`).expect(400);
    expect(prisma.warehouse.findUnique).not.toHaveBeenCalled();
  });
test('a missing warehouse returns 404', async () => {
  prisma.warehouse.findUnique.mockResolvedValue(null);
  await authorized('/api/warehouses/123').expect(404);
});
test('list requires authentication before any database lookup', async () => {
  await request(app).get('/api/warehouses').expect(401);
  expect(prisma.verifiedNumber.findFirst).not.toHaveBeenCalled();
  expect(prisma.warehouse.findMany).not.toHaveBeenCalled();
});

test.each([
  ['viewer', {}, false], ['reviewer', { reviewerAccess: true }, true], ['assignee', {}, true],
])('bundles active flags and notes into the warehouse page for a %s', async (role, grants, canOpen) => {
  prisma.verifiedNumber.findFirst.mockResolvedValue(active({ ...grants, editOwnWarehouseEntries: false, editAllWarehouseEntries: false }));
  prisma.warehouse.findMany.mockResolvedValue([warehouse, { ...warehouse, id: 124 }]);
  prisma.warehouse.count.mockResolvedValue(2);
  prisma.warehouseFieldReview.findMany.mockResolvedValue([{
    id: 'review-123', warehouseId: 123, assigneeId: role === 'assignee' ? 7 : 8,
    flags: [{ fieldKey: 'ratePerSqft', comment: 'Confirm the monthly rate.' }],
  }]);
  const { body } = await authorized('/api/warehouses?includeFieldReviews=true').expect(200);
  expect(body.data[0].fieldReviewSummary).toEqual({ warehouseId: 123, activeCount: 1,
    activeFieldKeys: ['ratePerSqft'], activeFields: [{ fieldKey: 'ratePerSqft', comment: 'Confirm the monthly rate.' }],
    canOpen, reviewId: canOpen ? 'review-123' : null });
  expect(body.data[1].fieldReviewSummary).toEqual({ warehouseId: 124, activeCount: 0,
    activeFieldKeys: [], activeFields: [], canOpen: false, reviewId: null });
  expect(prisma.warehouseFieldReview.findMany).toHaveBeenCalledTimes(1);
  expect(prisma.warehouseFieldReview.findMany).toHaveBeenCalledWith({
    where: { warehouseId: { in: [123, 124] }, closedAt: null },
    select: { id: true, warehouseId: true, assigneeId: true,
      flags: { where: { status: { not: 'VERIFIED' } }, select: { fieldKey: true, comment: true } } },
  });
  expect(JSON.stringify(body)).not.toContain(warehouse.contactNumber);
});

test('warehouse consumers that do not request flags avoid the review query and payload', async () => {
  prisma.warehouse.findMany.mockResolvedValue([warehouse]);
  prisma.warehouse.count.mockResolvedValue(1);
  const { body } = await authorized('/api/warehouses').expect(200);
  expect(body.data[0]).not.toHaveProperty('fieldReviewSummary');
  expect(prisma.warehouseFieldReview.findMany).not.toHaveBeenCalled();
});

test('a failed bundled review lookup does not silently report an unflagged warehouse', async () => {
  prisma.warehouse.findMany.mockResolvedValue([warehouse]);
  prisma.warehouse.count.mockResolvedValue(1);
  prisma.warehouseFieldReview.findMany.mockRejectedValue(new Error('Review lookup unavailable'));
  await authorized('/api/warehouses?includeFieldReviews=true').expect(500);
});

test('a fresh access revocation during the bundled lookup returns forbidden, not a server error', async () => {
  prisma.verifiedNumber.findFirst.mockResolvedValueOnce(active()).mockResolvedValue(active({ is_active: false }));
  prisma.warehouse.findMany.mockResolvedValue([warehouse]);
  prisma.warehouse.count.mockResolvedValue(1);
  const { body } = await authorized('/api/warehouses?includeFieldReviews=true').expect(403);
  expect(body.code).toBe('FIELD_REVIEW_FORBIDDEN');
  expect(prisma.warehouseFieldReview.findMany).not.toHaveBeenCalled();
});
