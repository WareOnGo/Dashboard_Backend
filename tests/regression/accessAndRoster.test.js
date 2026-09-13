const request = require('supertest');
const { app, prisma, storage, reset, tokenFor, active } = require('../helpers/app');
const { verifyScoutToken } = require('../../src/middleware/scoutMiddleware');
const VerifiedNumberService = require('../../src/services/verifiedNumberService');

beforeEach(reset);
const auth = email => ['Authorization', `Bearer ${tokenFor(email)}`];
const roles = [
  ['database admin', active({ adminAccess: true }), '', 204],
  ['environment admin', null, 'user@wareongo.com', 204],
  ['inactive environment admin override', active({ is_active: false }), 'user@wareongo.com', 204],
  ['dashboard user', active(), '', 403],
  ['reviewer', active({ reviewerAccess: true }), '', 403],
  ['inactive database admin', active({ adminAccess: true, is_active: false }), '', 403],
  ['missing roster entry', null, '', 403],
];

describe.each(['/api/warehouses/123', '/api/warehouses/files/fixture.jpg'])('DELETE %s', path => {
  test.each(roles)('%s', async (_name, row, admins, status) => {
    process.env.ADMIN_EMAILS = admins;
    prisma.verifiedNumber.findFirst.mockResolvedValue(row);
    prisma.warehouse.count.mockResolvedValue(1);
    prisma.warehouse.delete.mockResolvedValue({ id: 123 });
    storage.send.mockResolvedValue({});
    await request(app).delete(path).set(...auth()).expect(status);
    if (status === 403) {
      expect(prisma.warehouse.delete).not.toHaveBeenCalled();
      expect(storage.send).not.toHaveBeenCalled();
    } else if (path.endsWith('123')) {
      expect(prisma.warehouse.delete).toHaveBeenCalledWith({ where: { id: 123 } });
    } else {
      expect(storage.send.mock.calls[0][0].input).toEqual({ Bucket: 'warehouse-qa-fixture', Key: 'fixture.jpg' });
    }
  });
  test('anonymous requests cannot perform mutations', async () => {
    await request(app).delete(path).expect(401);
    expect(prisma.verifiedNumber.findFirst).not.toHaveBeenCalled();
    expect(storage.send).not.toHaveBeenCalled();
    expect(prisma.warehouse.delete).not.toHaveBeenCalled();
  });
});

async function scout(empID) {
  const req = { body: { uploadedBy: empID }, headers: {} };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await verifyScoutToken(req, res, next);
  return { req, res, next };
}
function rosterState(initial) {
  let stored = initial;
  prisma.verifiedNumber.findFirst.mockImplementation(async ({ where }) =>
    where.email.equals.toLowerCase() === stored.email?.toLowerCase() ? { ...stored } : null);
  prisma.verifiedNumber.findUnique.mockImplementation(async ({ where }) =>
    where.id === stored.id || where.empID === stored.empID ? { ...stored } : null);
  prisma.verifiedNumber.update.mockImplementation(async ({ data }) => {
    stored = { ...stored, ...data }; return { ...stored };
  });
  prisma.warehouse.findMany.mockResolvedValue([]);
  prisma.warehouse.count.mockResolvedValue(0);
  return () => stored;
}

test('an admin deactivation revokes already-cached dashboard and Scout access on the next request', async () => {
  process.env.ADMIN_EMAILS = 'boss@wareongo.com';
  rosterState(active());
  await request(app).get('/api/warehouses').set(...auth()).expect(200);
  expect((await scout('QA1234')).next).toHaveBeenCalledTimes(1);
  await request(app).patch('/api/verified-numbers/admin/7').set(...auth('boss@wareongo.com'))
    .send({ is_active: false }).expect(200);
  await request(app).get('/api/warehouses').set(...auth()).expect(403);
  const after = await scout('QA1234');
  expect(after.res.status).toHaveBeenCalledWith(403);
  expect(after.next).not.toHaveBeenCalled();
  expect(prisma.warehouse.findMany).toHaveBeenCalledTimes(1);
});

test('changing email and employee id invalidates both old and new cached identities', async () => {
  process.env.ADMIN_EMAILS = 'boss@wareongo.com';
  rosterState(active());
  await request(app).get('/api/warehouses').set(...auth()).expect(200);
  await request(app).get('/api/warehouses').set(...auth('new@wareongo.com')).expect(403);
  expect((await scout('QA1234')).next).toHaveBeenCalledTimes(1);
  await request(app).patch('/api/verified-numbers/admin/7').set(...auth('boss@wareongo.com'))
    .send({ email: 'new@wareongo.com', empID: 'NEW123', confirmIdentityChange: true }).expect(200);
  await request(app).get('/api/warehouses').set(...auth()).expect(403);
  await request(app).get('/api/warehouses').set(...auth('new@wareongo.com')).expect(200);
  expect((await scout('QA1234')).res.status).toHaveBeenCalledWith(401);
  expect((await scout('NEW123')).next).toHaveBeenCalledTimes(1);
});

describe('roster create contract', () => {
  beforeEach(() => { process.env.ADMIN_EMAILS = 'boss@wareongo.com'; });
  test.each([
    { name: 'New Hire', email: 'hire@wareongo.com' },
    { name: 'New Hire', phone_number: null },
    { name: 'New Hire', phone_number: '' },
    { name: 'New Hire', phone_number: 'invalid' },
  ])('rejects missing/invalid required phone: %j', async payload => {
    await request(app).post('/api/verified-numbers/admin').set(...auth('boss@wareongo.com'))
      .send(payload).expect(400);
    expect(prisma.verifiedNumber.create).not.toHaveBeenCalled();
    expect(prisma.verifiedNumber.findUnique).not.toHaveBeenCalled();
  });
  test.each([undefined, 'Hire@WareOnGo.com'])('creates a valid phone-backed row with email %s', async email => {
    prisma.verifiedNumber.findFirst.mockResolvedValue(null);
    prisma.verifiedNumber.findUnique.mockResolvedValue(null);
    prisma.verifiedNumber.create.mockImplementation(async ({ data }) => ({ id: 8, ...data }));
    await request(app).post('/api/verified-numbers/admin').set(...auth('boss@wareongo.com'))
      .send({ name: 'New Hire', phone_number: '+91 98000-00001', email }).expect(201);
    expect(prisma.verifiedNumber.create.mock.calls[0][0].data).toMatchObject({
      phone_number: '919800000001', empID: expect.stringMatching(/^[A-Z0-9]{6}$/),
      ...(email ? { email: 'hire@wareongo.com' } : {}),
    });
  });
  test.each([undefined, null, 919800000001, true, {}, [], '', 'invalid'])
    ('the service rejects invalid phone %j without the HTTP validator', async phone_number => {
    const createOne = jest.fn();
    const service = new VerifiedNumberService({ createOne });
    await expect(service.create({ name: 'New Hire', email: 'hire@wareongo.com', phone_number }, {}))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(createOne).not.toHaveBeenCalled();
  });
});
