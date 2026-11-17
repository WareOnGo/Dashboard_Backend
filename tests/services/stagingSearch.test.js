const StagingService = require('../../src/services/stagingService');

// The review queue searches the whole tab server-side with the dashboard's matcher.
const staged = (id, fields = {}) => ({
    id, submittedAt: new Date('2026-01-01'), warehouseId: null, address: '', city: '', state: '',
    postalCode: null, contactPerson: '', ownerAltPoc: null, ownerCompanyName: null,
    contactNumber: '', alt_phone_number: null, ...fields,
});

const serviceFor = (candidates) => {
    const model = {
        findAll: jest.fn().mockResolvedValue([]),
        findSearchCandidates: jest.fn().mockResolvedValue(candidates),
        findByIds: jest.fn(async (ids) => candidates.filter((row) => ids.includes(row.id)).reverse()),
    };
    return { model, service: new StagingService(model, null, null) };
};

test('without a search the tab pages newest first, as before', async () => {
    const { model, service } = serviceFor([]);
    await service.listSubmissions({ reviewStatus: 'PENDING', page: 2, limit: 10 });
    expect(model.findAll).toHaveBeenCalledWith({ reviewStatus: 'PENDING', skip: 10, take: 10 });
    expect(model.findSearchCandidates).not.toHaveBeenCalled();
});

test('a search ranks the whole tab, newest submission first within a tier', async () => {
    const { model, service } = serviceFor([
        staged('a', { address: 'Plot 4, Peenya 2nd Stage', submittedAt: new Date('2026-03-01') }),
        staged('b', { address: 'Near Peenya Industrial Area', submittedAt: new Date('2026-05-01') }),
        staged('c', { warehouseType: 'Peenya' }),
        staged('d', { contactPerson: 'Peenya Traders' }),
    ]);
    const rows = await service.listSubmissions({ reviewStatus: 'APPROVED', search: 'peenya' });
    expect(model.findSearchCandidates).toHaveBeenCalledWith({ reviewStatus: 'APPROVED' });
    // Owner name (Exact bucket) first, then address hits newest first; type is not searched.
    expect(rows.map((row) => row.id)).toEqual(['d', 'b', 'a']);
});

test('a search pages its ranked results', async () => {
    const { service } = serviceFor(['a', 'b', 'c'].map((id, i) => staged(id, {
        contactPerson: 'Mukesh', submittedAt: new Date(2026, 0, 3 - i),
    })));
    expect((await service.listSubmissions({ search: 'mukesh', page: 2, limit: 2 })).map((row) => row.id)).toEqual(['c']);
});

test('a warehouse ID finds the submissions for that warehouse', async () => {
    const { service } = serviceFor([staged('x', { warehouseId: 1503 }), staged('y', { warehouseId: 15 })]);
    expect((await service.listSubmissions({ search: '1503' })).map((row) => row.id)).toEqual(['x']);
});

test('a pasted ID list returns submissions in pasted warehouse order', async () => {
    const { service } = serviceFor([
        staged('new7', { warehouseId: 7 }), staged('x', { warehouseId: 12 }),
        staged('old7', { warehouseId: 7 }), staged('y', { warehouseId: 99 }),
    ]);
    const rows = await service.listSubmissions({ search: '12, 3, 7' });
    expect(rows.map((row) => row.id)).toEqual(['x', 'new7', 'old7']);
});

test('the review queue query accepts a search and caps pasted ID lists like the dashboard', () => {
    const StagingValidator = require('../../src/validators/stagingValidator');
    expect(StagingValidator.listQuerySchema.parse({ search: 'peenya' })).toEqual({ search: 'peenya' });
    const tooMany = Array.from({ length: 501 }, (_, i) => i + 1).join(',');
    expect(StagingValidator.listQuerySchema.safeParse({ search: tooMany }).success).toBe(false);
});
