jest.mock('../../src/models/imagePipelineRepository.cjs', () => ({ registerWarehouseImages: jest.fn(async () => {}) }));
const { registerWarehouseImages } = require('../../src/models/imagePipelineRepository.cjs');
const StagedWarehouseModel = require('../../src/models/stagedWarehouseModel');
const REVIEWER = { email: 'reviewer@wareongo.com', name: 'Reviewer', ip: '127.0.0.1' };
const payload = () => ({ warehouseType: 'Industrial', city: 'Bengaluru', state: 'Karnataka',
    warehouseData: { latitude: 12.9, longitude: 77.5 } });
function fixture() {
    return { stagedWarehouse: {}, $queryRawUnsafe: jest.fn(async () => [{ created: { id: 1713, WarehouseData: {} } }]),
        warehouse: { delete: jest.fn() }, auditLog: { create: jest.fn(async () => ({})) } };
}
beforeEach(() => jest.clearAllMocks());
test('promotion registers images after the atomic statement succeeds', async () => {
    const prisma = fixture();
    const result = await new StagedWarehouseModel(prisma).promote('staged', payload(), REVIEWER);
    expect(result.id).toBe(1713);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(registerWarehouseImages).toHaveBeenCalledWith(prisma, 1713);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'APPROVE' }) }));
});
test('lost approval race reports conflict without registration or an approval audit', async () => {
    const prisma = fixture(); prisma.$queryRawUnsafe.mockResolvedValue([]);
    await expect(new StagedWarehouseModel(prisma).promote('staged', payload(), REVIEWER)).rejects.toMatchObject({ statusCode: 409 });
    expect(registerWarehouseImages).not.toHaveBeenCalled(); expect(prisma.auditLog.create).not.toHaveBeenCalled();
});
test('failed statement never attempts a compensating deletion or claims success', async () => {
    const prisma = fixture(); prisma.$queryRawUnsafe.mockRejectedValue(new Error('fixture link failure'));
    await expect(new StagedWarehouseModel(prisma).promote('staged', payload(), REVIEWER)).rejects.toThrow('fixture link failure');
    expect(prisma.warehouse.delete).not.toHaveBeenCalled(); expect(registerWarehouseImages).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
});
test('media and SQL-looking values remain bound parameters; unknown columns are rejected', async () => {
    const prisma = fixture(), model = new StagedWarehouseModel(prisma);
    const value = "'); DELETE FROM warehouses; --";
    await model.promote('staged', { ...payload(), address: value, media: { images: ['https://fixture.test/raw.jpg'] } }, REVIEWER);
    const [sql, , data] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).not.toContain(value); expect(JSON.parse(data).address).toBe(value);
    expect(JSON.parse(data).media.images).toEqual(['https://fixture.test/raw.jpg']);
    await expect(model.promote('staged', { ...payload(), unknownColumn: value }, REVIEWER)).rejects.toThrow('Invalid promotion fields');
});
