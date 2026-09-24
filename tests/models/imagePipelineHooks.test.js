jest.mock('../../src/models/imagePipelineRepository.cjs', () => ({ registerWarehouseImages: jest.fn(async () => {}) }));
const { registerWarehouseImages } = require('../../src/models/imagePipelineRepository.cjs');
const WarehouseModel = require('../../src/models/warehouseModel');
const StagedWarehouseModel = require('../../src/models/stagedWarehouseModel');
beforeEach(() => jest.clearAllMocks());
const media = { images: ['https://fixture.test/original.jpg'], videos: ['https://fixture.test/video.mp4'] };
function fixture() {
    return { warehouse: { create: jest.fn(async () => ({ id: 8, media })), update: jest.fn(async () => ({ id: 8, media })),
        delete: jest.fn(async () => ({})) }, stagedWarehouse: { updateMany: jest.fn(async () => ({ count: 1 })) },
    auditLog: { create: jest.fn(async () => ({})) } };
}
test('accepted creates and image edits register references while ordinary edits do not', async () => {
    const prisma = fixture(), model = new WarehouseModel(prisma);
    await model.create({ media, warehouseData: {} });
    expect(prisma.warehouse.create.mock.calls[0][0].data.media).toEqual(media);
    expect(registerWarehouseImages).toHaveBeenCalledWith(prisma, 8);
    await model.update(8, { city: 'New City' });
    expect(registerWarehouseImages).toHaveBeenCalledTimes(1);
    await model.update(8, { media: { images: [] } });
    expect(registerWarehouseImages).toHaveBeenCalledTimes(2);
    expect(prisma.warehouse.update.mock.calls[1][0].data.media).toEqual({ images: [] });
});
test('promotion registers only after the warehouse has been linked successfully', async () => {
    const prisma = fixture(), model = new StagedWarehouseModel(prisma);
    await model.promote('staged', { media, warehouseData: {} }, { email: 'fixture@example.test' });
    expect(registerWarehouseImages).toHaveBeenCalledWith(prisma, 8);
    registerWarehouseImages.mockClear();
    prisma.stagedWarehouse.updateMany.mockResolvedValueOnce({ count: 1 }).mockRejectedValueOnce(new Error('link failed'));
    await expect(model.promote('staged', { media, warehouseData: {} }, { email: 'fixture@example.test' })).rejects.toThrow('link failed');
    expect(registerWarehouseImages).not.toHaveBeenCalled();
});
