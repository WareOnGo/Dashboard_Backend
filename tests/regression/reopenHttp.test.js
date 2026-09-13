const request = require('supertest');
const { Prisma } = require('@prisma/client');
const { app, prisma, reset, tokenFor, active } = require('../helpers/app');
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const row = { id, reviewStatus: 'APPROVED', warehouseId: 123, reviewedBy: 'old@wareongo.com', reviewedAt: new Date('2026-01-01T00:00:00Z') };
const reopened = { ...row, reviewStatus: 'PENDING', warehouseId: null, reviewedBy: null, reviewedAt: null, rejectionReason: null };
const reopen = () => request(app).post(`/api/staging/${id}/reopen`).set('Authorization', `Bearer ${tokenFor()}`);
beforeEach(() => {
  reset();
  prisma.verifiedNumber.findFirst.mockResolvedValue(active({ reviewerAccess: true }));
  prisma.stagedWarehouse.findUnique.mockResolvedValue({ ...row });
  prisma.warehouse.findMany.mockResolvedValue([{ id: 123 }]);
});
test('production reopen route returns the committed pending row', async () => {
  prisma.$queryRaw.mockResolvedValue([{ ...reopened, _warehouseRemoved: true }]);
  expect((await reopen().expect(200)).body).toEqual(reopened);
  expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'REOPEN', entityId: id }) }));
});
test('a lost reopen claim surfaces as a 409 without a false audit', async () => {
  prisma.$queryRaw.mockResolvedValue([]);
  await reopen().expect(409);
  expect(prisma.auditLog.create).not.toHaveBeenCalled();
});
test('a database delete failure is not reported as a successful reopen', async () => {
  prisma.$queryRaw.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('fixture FK failure', { code: 'P2010', clientVersion: '6.17.1', meta: { code: '23503' } }));
  await reopen().expect(500);
  expect(prisma.auditLog.create).not.toHaveBeenCalled();
});
test('a missing submission returns 404 without attempting a reopen', async () => {
  prisma.stagedWarehouse.findUnique.mockResolvedValue(null);
  await reopen().expect(404);
  expect(prisma.$queryRaw).not.toHaveBeenCalled();
});
test('a dashboard-only user cannot reopen', async () => {
  prisma.verifiedNumber.findFirst.mockResolvedValue(active());
  await reopen().expect(403);
  expect(prisma.$queryRaw).not.toHaveBeenCalled();
});
