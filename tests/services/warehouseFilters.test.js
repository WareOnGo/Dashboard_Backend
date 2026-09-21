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

test.each(['9876543210', '+91 (98765) 43210', '0091 98765-43210', '09876543210'])(
    'mobile search %s combines with other filters for list, count, and coordinates', async search => {
        const model = {
            findIdsByContactNumber: jest.fn().mockResolvedValue([7, 9]),
            findIdsByNumericRange: jest.fn().mockResolvedValue([9, 12]),
            findAll: jest.fn().mockResolvedValue([{ id: 9, contactNumber: '+919876543210' }]),
            count: jest.fn().mockResolvedValue(1),
            findCoordinates: jest.fn().mockResolvedValue([
                { id: 9, WarehouseData: { latitude: 22.7, longitude: 75.8 } },
            ]),
        };
        const service = new WarehouseService(model);
        const filters = { search, city: 'Indore', ids: '9,12', minArea: '5000' };
        const result = await service.getAllWarehouses({ ...filters, page: '2', limit: '10' });
        await service.getWarehouseCoordinates(filters);
        expect(model.findIdsByContactNumber).toHaveBeenCalledWith('9876543210');
        const where = model.findAll.mock.calls[0][0].where;
        expect(where.OR).toEqual(expect.arrayContaining([
            { id: { in: [7, 9] } }, { address: { contains: search, mode: 'insensitive' } },
        ]));
        expect(where.OR.filter(clause => typeof clause.id === 'number')).toEqual([]);
        expect(where).toMatchObject({
            id: { in: [9, 12] }, city: { contains: 'Indore', mode: 'insensitive' },
            AND: [{ id: { in: [9, 12] } }],
        });
        expect(model.findAll.mock.calls[0][0]).toMatchObject({ skip: 10, take: 10 });
        expect(model.count).toHaveBeenCalledWith(where);
        expect(model.findCoordinates).toHaveBeenCalledWith(where);
        expect(result.data[0]).not.toHaveProperty('contactNumber');
        expect(result.pagination.total).toBe(1);
    },
);

test('an unmatched mobile number keeps text search available and cannot match all IDs', async () => {
    const service = new WarehouseService({ findIdsByContactNumber: jest.fn().mockResolvedValue([]) });
    const where = await service.buildWhere({ search: '9876543210' });
    expect(where.OR).toContainEqual({ id: { in: [] } });
    expect(where.OR).toContainEqual({ address: { contains: '9876543210', mode: 'insensitive' } });
});

test.each(['42', 'Sector 9876', '   '])('search %s avoids a phone query', async search => {
    const model = { findIdsByContactNumber: jest.fn() };
    const where = await new WarehouseService(model).buildWhere({ search });
    expect(model.findIdsByContactNumber).not.toHaveBeenCalled();
    if (search === '42') expect(where.OR).toContainEqual({ id: 42 });
    if (!search.trim()) expect(where).toEqual({});
});

test('phone lookup failures propagate instead of returning misleading empty results', async () => {
    const model = { findIdsByContactNumber: jest.fn().mockRejectedValue(new Error('Unavailable')) };
    await expect(new WarehouseService(model).getAllWarehouses({ search: '9876543210' })).rejects.toThrow('Unavailable');
});
