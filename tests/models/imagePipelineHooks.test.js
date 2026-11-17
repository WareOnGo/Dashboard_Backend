jest.mock('../../src/models/imagePipelineRepository.cjs', () => ({ registerWarehouseImages: jest.fn(async () => {}) }));
const { registerWarehouseImages } = require('../../src/models/imagePipelineRepository.cjs');
const WarehouseModel = require('../../src/models/warehouseModel');
const StagedWarehouseModel = require('../../src/models/stagedWarehouseModel');
beforeEach(() => jest.clearAllMocks());
const media = { images: ['https://fixture.test/original.jpg'], videos: ['https://fixture.test/video.mp4'] };
function fixture() {
    return { $queryRawUnsafe: jest.fn(async () => [{ created: { id: 8, media } }]), warehouse: { create: jest.fn(async () => ({ id: 8, media })), update: jest.fn(async () => ({ id: 8, media })),
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
    prisma.$queryRawUnsafe.mockRejectedValueOnce(new Error('link failed'));
    await expect(model.promote('staged', { media, warehouseData: {} }, { email: 'fixture@example.test' })).rejects.toThrow('link failed');
    expect(registerWarehouseImages).not.toHaveBeenCalled();
});

test('authenticated edits commit before best-effort image registration', async () => {
    const prisma = fixture();
    const events = [];
    prisma.$transaction = jest.fn(async operation => {
        expect(Array.isArray(operation)).toBe(true);
        const saved = await Promise.all(operation);
        events.push('committed');
        return saved;
    });
    registerWarehouseImages.mockImplementationOnce(async client => {
        expect(client).toBe(prisma);
        expect(events).toEqual(['committed']);
        events.push('registered');
    });
    const result = await new WarehouseModel(prisma).update(8, { media }, undefined, { actorEmail: 'editor@example.test' });
    expect(result.id).toBe(8);
    expect(events).toEqual(['committed', 'registered']);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining("wareongo.actor_email"), 'editor@example.test');
});
