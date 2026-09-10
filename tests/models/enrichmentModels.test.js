const CronRunLogModel = require('../../src/models/cronRunLogModel');
const ProximityModel = require('../../src/models/warehouseProximityModel');

function prismaMock() {
    const tx = {
        $executeRawUnsafe: jest.fn(async () => 1), $queryRaw: jest.fn(async () => [{ acquired: true }]),
        cronRunLog: { findFirst: jest.fn(async () => null), create: jest.fn(async () => ({ id: 1n })) },
        warehouseProximity: {},
    };
    const prisma = { ...tx, $transaction: jest.fn(async fn => fn(tx)) };
    return { prisma, tx };
}
test('a held transaction lock prevents a concurrent claim before any run is created', async () => {
    const { prisma, tx } = prismaMock();
    tx.$queryRaw.mockResolvedValue([{ acquired: false }]);
    expect(await new CronRunLogModel(prisma).tryStart('job', 900000)).toBeNull();
    expect(tx.cronRunLog.create).not.toHaveBeenCalled();
});
test('a fresh RUNNING record continues to exclude other instances after the short lock is released', async () => {
    const { prisma, tx } = prismaMock();
    tx.cronRunLog.findFirst.mockResolvedValue({ id: 2n });
    expect(await new CronRunLogModel(prisma).tryStart('job', 900000)).toBeNull();
    expect(tx.cronRunLog.create).not.toHaveBeenCalled();
});
test('new claims check and create within one transaction', async () => {
    const { prisma, tx } = prismaMock();
    expect(await new CronRunLogModel(prisma).tryStart('job', 900000)).toEqual({ id: 1n });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.cronRunLog.create).toHaveBeenCalledWith({ data: { jobName: 'job', status: 'RUNNING', durationMs: 0, metadata: null } });
});
test('a moved or deleted warehouse discards results before issuing an upsert', async () => {
    const { prisma, tx } = prismaMock();
    tx.$queryRaw.mockResolvedValue([]);
    expect(await new ProximityModel(prisma).upsertCurrent({ id: 1, lat: 12, lng: 77 }, [{ category: 'hospital' }])).toBe(0);
    expect(tx.$executeRawUnsafe.mock.calls.every(([sql]) => !sql.includes('INSERT'))).toBe(true);
});
