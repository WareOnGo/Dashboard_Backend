const WarehouseService = require('../../src/services/warehouseService');
const WarehouseModel = require('../../src/models/warehouseModel');

test('advanced filters survive validation and reach list, count and map queries together', async () => {
    const model = {
        findAll: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0),
        findCoordinates: jest.fn().mockResolvedValue([]),
    };
    const service = new WarehouseService(model);
    const filters = {
        contactPerson: 'Sharma', listing_type: 'Rent',
        status: 'Ready', state: 'Karnataka', city: 'Bengaluru', warehouseType: 'PEB',
        fireNoc: 'available', landType: 'Industrial',
    };
    await service.getAllWarehouses({ ...filters, page: '2', limit: '10' });
    await service.getWarehouseCoordinates(filters);
    const where = model.findAll.mock.calls[0][0].where;
    for (const field of ['contactPerson', 'listing_type', 'status', 'state', 'city', 'warehouseType']) {
        expect(where[field]).toEqual({ contains: filters[field], mode: 'insensitive' });
    }
    expect(where.AND).toEqual([
        { WarehouseData: { is: { fireNocAvailable: true } } },
        { WarehouseData: { is: { landType: { contains: 'Industrial', mode: 'insensitive' } } } },
    ]);
    expect(model.findAll.mock.calls[0][0]).toMatchObject({ skip: 10, take: 10 });
    expect(model.count).toHaveBeenCalledWith(where);
    expect(model.findCoordinates).toHaveBeenCalledWith(where);
});

test('unavailable Fire NOC includes records without an affirmative certificate', async () => {
    const where = await new WarehouseService({}).buildWhere({ fireNoc: 'not_available', contactPerson: 'Sharma' });
    expect(where.AND).toEqual([{ NOT: { WarehouseData: { is: { fireNocAvailable: true } } } }]);
    expect(where.contactPerson.contains).toBe('Sharma');
});

test('filter metadata contains only distinct location pairs and types with no page limit', async () => {
    const groupBy = jest.fn(({ by }) => Promise.resolve(by.includes('city')
        ? [{ state: 'Karnataka', city: 'Bengaluru' }, { state: null, city: 'Legacy city' }]
        : [{ warehouseType: 'PEB' }, { warehouseType: null }]));
    const service = new WarehouseService(new WarehouseModel({ warehouse: { groupBy } }));
    await expect(service.getFilterOptions()).resolves.toEqual({
        locations: [{ state: 'Karnataka', city: 'Bengaluru' }, { state: null, city: 'Legacy city' }],
        warehouseTypes: ['PEB'],
    });
    expect(groupBy.mock.calls).toEqual([[{ by: ['state', 'city'] }], [{ by: ['warehouseType'] }]]);
});

test('metadata errors propagate so the client can offer retry', async () => {
    const service = new WarehouseService({ findFilterOptions: jest.fn().mockRejectedValue(new Error('Unavailable')) });
    await expect(service.getFilterOptions()).rejects.toThrow('Unavailable');
});
