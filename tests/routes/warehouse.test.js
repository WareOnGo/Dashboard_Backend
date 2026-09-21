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
    prisma.microMarket.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([{ id: warehouse.id }]);
    prisma.warehouse.findMany.mockResolvedValue([warehouse]);
    prisma.warehouse.count.mockResolvedValue(1);
    const { body } = await authorized('/api/warehouses').query({ search }).expect(200);
    expect(body.data.map(row => row.id)).toEqual([warehouse.id]);
    expect(body.data[0]).not.toHaveProperty('contactNumber');
    expect(body.pagination.total).toBe(1);
    const where = prisma.warehouse.findMany.mock.calls[0][0].where;
    expect(where.OR).toContainEqual({ id: { in: [warehouse.id] } });
    expect(prisma.warehouse.count).toHaveBeenCalledWith({ where });
    const query = Prisma.sql(...prisma.$queryRaw.mock.calls[0]);
    expect(query.text).toContain('w."contactNumber"');
    expect(query.text).toContain('w."alt_phone_number"');
    expect(query.text).not.toContain('9800000001');
    expect(query.values).toEqual(['%9800000001%', '%9800000001%']);
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
