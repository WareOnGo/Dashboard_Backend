const WarehouseValidator = require('../../src/validators/warehouseValidator');
const StagingValidator = require('../../src/validators/stagingValidator');

const base = {
    warehouseType: 'PEB', address: 'Test locality', city: 'New Delhi', state: 'Delhi',
    contactPerson: 'Test', contactNumber: '9999999999', totalSpaceSqft: [10000],
    compliances: 'Fire NOC', ratePerSqft: '25', uploadedBy: 'QA', warehouseData: {},
};

describe.each([
    ['create', data => WarehouseValidator.validateCreate({ ...base, ...data })],
    ['update', data => WarehouseValidator.validateUpdate(data)],
    ['staging ingest', data => StagingValidator.ingestSchema.safeParse(data)],
])('%s lock-in date validation', (_label, validate) => {
    test.each([
        false, true, 0, [], ['2026-01-01'], '', ' ', '0000-01-01',
        '2025-02-29', '2026-02-30', '2026-04-31', '2026-02-30T00:00:00.000Z',
        '2026-10-25T24:00:00Z', new Date(NaN),
    ])('rejects %p without inventing a date', lockInDate => {
        const result = validate({ lockInDate });
        expect(result.success).toBe(false);
        expect(result.error.issues.some(issue => issue.path[0] === 'lockInDate')).toBe(true);
    });

    test.each([
        '2024-02-29', '2028-02-29', '2028-02-29T00:00:00.000Z', new Date('2028-02-29'),
    ])('preserves valid %p through repeated validation and serialization', lockInDate => {
        const result = validate({ lockInDate });
        expect(result.success).toBe(true);
        expect(result.data.lockInDate).toEqual(new Date(lockInDate));
        // Middleware and services validate separately; both must accept Dates.
        expect(validate(result.data).success).toBe(true);
        const serialized = validate(JSON.parse(JSON.stringify(result.data)));
        expect(serialized.success).toBe(true);
        expect(serialized.data.lockInDate).toEqual(result.data.lockInDate);
    });

    test('keeps an omitted or explicitly cleared lock-in date optional', () => {
        expect(validate({}).success).toBe(true);
        const cleared = validate({ lockInDate: null });
        expect(cleared.success).toBe(true);
        expect(cleared.data.lockInDate).toBeNull();
    });
});
