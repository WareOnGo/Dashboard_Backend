const WarehouseService = require('../../src/services/warehouseService');

test('warehouse updates ignore client-supplied proximity while preserving editable fields', async () => {
    const saved = { id: 123, city: 'Lucknow', WarehouseData: {} };
    const model = {
        findById: jest.fn().mockResolvedValue(saved),
        update: jest.fn().mockResolvedValue(saved),
    };
    const proximity = [{ category: 'aerodrome', roadKm: 0, landmarkName: 'Client override' }];
    await new WarehouseService(model).updateWarehouse(123, {
        city: 'Kanpur', WarehouseProximity: proximity, warehouseProximity: proximity,
        warehouseData: { latitude: 26.45, longitude: 80.35, WarehouseProximity: proximity },
    });
    const [, payload] = model.update.mock.calls[0];
    expect(payload).toMatchObject({ city: 'Kanpur', warehouseData: { latitude: 26.45, longitude: 80.35 } });
    expect(payload).not.toHaveProperty('WarehouseProximity');
    expect(payload).not.toHaveProperty('warehouseProximity');
    expect(payload.warehouseData).not.toHaveProperty('WarehouseProximity');
});
