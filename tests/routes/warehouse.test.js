const request = require('supertest');
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
  expect(JSON.stringify(where)).toContain('Indore');
  expect(prisma.warehouse.count).toHaveBeenCalledWith({ where });
});
test('production detail loads the requested record and redacts contact data', async () => {
  prisma.warehouse.findUnique.mockResolvedValue(warehouse);
  const { body } = await authorized('/api/warehouses/123').expect(200);
  expect(body.id).toBe(123);
  expect(body).not.toHaveProperty('contactNumber');
  expect(prisma.warehouse.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 123 } }));
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
