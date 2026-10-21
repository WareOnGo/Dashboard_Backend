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

// --- Search: ranked in memory over the filtered rows, then paged by id ---
// Pasted-ID resolution against real rows is covered in
// tests/integration/warehouseSearch.test.js.

const candidate = (id, fields = {}) => ({
    id, createdAt: new Date('2026-01-01'), address: '', city: '', state: '', postalCode: null,
    contactPerson: '', ownerAltPoc: null, ownerCompanyName: null, contactNumber: '',
    alt_phone_number: null, micromarket: [], ...fields,
});

/** A model whose findAll returns full rows for whichever ids it is asked for. */
const searchModel = (candidates) => ({
    findSearchCandidates: jest.fn().mockResolvedValue(candidates),
    findAll: jest.fn(async ({ where }) => candidates.filter((c) => where.id.in.includes(c.id))),
    findCoordinates: jest.fn().mockResolvedValue([]),
    count: jest.fn(async (where) => where.id.in.length),
});

test('search results come back in relevance order, with the matched total', async () => {
    const model = searchModel([
        candidate(1, { micromarket: ['Cheemasandra'], createdAt: new Date('2026-10-01') }),
        candidate(2, { address: 'Bommasandra-Jigani Link Road', micromarket: ['Jigani'] }),
        candidate(3, { micromarket: ['Bommasandra'] }),
        candidate(4, { city: 'Bengaluru' }),
    ]);
    const result = await new WarehouseService(model).getAllWarehouses({ search: 'Bommasandra', city: 'Bengaluru' });
    expect(model.findSearchCandidates).toHaveBeenCalledWith({ city: { contains: 'Bengaluru', mode: 'insensitive' } });
    expect(result.data.map((w) => w.id)).toEqual([3, 2]);
    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
    expect(result).not.toHaveProperty('search');
    expect(model.count).not.toHaveBeenCalled();
});

test('a later page fetches only that page of the ranked ids', async () => {
    const model = searchModel([1, 2, 3, 4, 5].map((id) => candidate(id, {
        micromarket: ['Peenya'], createdAt: new Date(2026, 0, id),
    })));
    const result = await new WarehouseService(model).getAllWarehouses({ search: 'peenya', page: '2', limit: '2' });
    expect(model.findAll).toHaveBeenCalledWith({ where: { id: { in: [3, 2] } } });
    expect(result.data.map((w) => w.id)).toEqual([3, 2]);
    expect(result.pagination).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
});

test('an explicit column sort replaces relevance order over the same matched set', async () => {
    const model = searchModel([candidate(1, { micromarket: ['Peenya'] }), candidate(2, { address: 'Peenya 2nd Stage' }), candidate(3)]);
    const result = await new WarehouseService(model).getAllWarehouses({ search: 'peenya', sortBy: 'ratePerSqft', sortOrder: 'asc', limit: '10' });
    expect(model.findAll).toHaveBeenCalledWith({
        where: { id: { in: [1, 2] } }, orderBy: { ratePerSqft: 'asc' }, skip: 0, take: 10,
    });
    expect(result.pagination.total).toBe(2);
    expect(model.count).not.toHaveBeenCalled();
});

test('a search that matches nothing returns an empty page without fetching rows', async () => {
    const model = searchModel([candidate(1, { city: 'Indore' })]);
    const result = await new WarehouseService(model).getAllWarehouses({ search: 'zzzz' });
    expect(result.data).toEqual([]);
    expect(result.pagination.total).toBe(0);
    expect(model.findAll).not.toHaveBeenCalled();
});

test.each(['9876543210', '+91 (98765) 43210', '0091 98765-43210', '09876543210'])(
    'mobile search %s matches the primary or alternate number in any stored format', async (search) => {
        const model = searchModel([
            candidate(7, { contactNumber: '+91 98765 43210' }),
            candidate(9, { contactNumber: '9000000000', alt_phone_number: '098765-43210' }),
            candidate(12, { contactNumber: '9000000001' }),
        ]);
        const result = await new WarehouseService(model).getAllWarehouses({ search });
        expect(result.data.map((w) => w.id).sort()).toEqual([7, 9]);
        expect(result.data[0]).not.toHaveProperty('contactNumber');
    },
);

test('the map coordinates use exactly the matched ids', async () => {
    const model = searchModel([candidate(1, { micromarket: ['Peenya'] }), candidate(2)]);
    await new WarehouseService(model).getWarehouseCoordinates({ search: 'peenya', city: 'Bengaluru' });
    expect(model.findCoordinates).toHaveBeenCalledWith({ id: { in: [1] } });
});

test('a whitespace-only search is no search at all', async () => {
    const model = { findAll: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), findSearchCandidates: jest.fn() };
    await new WarehouseService(model).getAllWarehouses({ search: '   ', city: 'Indore' });
    expect(model.findSearchCandidates).not.toHaveBeenCalled();
    expect(model.findAll).toHaveBeenCalledWith(expect.objectContaining({
        where: { city: { contains: 'Indore', mode: 'insensitive' } }, orderBy: { createdAt: 'desc' }, skip: 0, take: 20,
    }));
});

test('search failures propagate instead of returning misleading empty results', async () => {
    const model = { findSearchCandidates: jest.fn().mockRejectedValue(new Error('Unavailable')) };
    await expect(new WarehouseService(model).getAllWarehouses({ search: '9876543210' })).rejects.toThrow('Unavailable');
});

test('an over-long search is a validation error before any query', async () => {
    const model = searchModel([]);
    await expect(new WarehouseService(model).getAllWarehouses({ search: 'a'.repeat(4001) }))
        .rejects.toMatchObject({ name: 'ValidationError' });
    expect(model.findSearchCandidates).not.toHaveBeenCalled();
});

test('more than 500 pasted IDs is a validation error before any query', async () => {
    const model = searchModel([]);
    const term = Array.from({ length: 501 }, (_, i) => i + 1).join(',');
    await expect(new WarehouseService(model).getAllWarehouses({ search: term }))
        .rejects.toMatchObject({ name: 'ValidationError' });
    expect(model.findSearchCandidates).not.toHaveBeenCalled();
});
