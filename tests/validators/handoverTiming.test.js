const WarehouseValidator = require('../../src/validators/warehouseValidator');
const StagingValidator = require('../../src/validators/stagingValidator');
const { formatHandover } = require('../../src/ppt/utils/handover');

const base = {
    warehouseType: 'PEB', address: 'Test address', city: 'Indore', state: 'Madhya Pradesh',
    contactPerson: 'Test', contactNumber: '9800000001', totalSpaceSqft: [10000],
    compliances: 'Fire NOC', ratePerSqft: '25', uploadedBy: 'QA', warehouseData: {},
};
const NOW = new Date('2026-10-25T00:00:00Z');

describe.each([
    ['create', data => WarehouseValidator.validateCreate({ ...base, ...data })],
    ['update', data => WarehouseValidator.validateUpdate(data)],
    ['staging ingest', data => StagingValidator.ingestSchema.safeParse(data)],
])('%s handover validation before storage', (_label, validate) => {
    test.each([false, true, 0, [], ['2026-01-01'], '', ' ', '2026-02-30',
        '2026-04-31', '2025-02-29', '2026-02-30T00:00:00.000Z', '2026-10-25T24:00:00Z'])(
        'rejects %p rather than manufacturing a handover date', handoverDate => {
            const result = validate({ handoverType: 'FIXED', handoverDate });
            expect(result.success).toBe(false);
            expect(result.error.issues.some(issue => issue.path[0] === 'handoverDate')).toBe(true);
        },
    );

    test.each([true, false, [2], ['2'], '', ' ', 0, -1, 1.5, 121, 'soon'])(
        'rejects %p rather than manufacturing a lead time', handoverLeadValue => {
            const result = validate({ handoverType: 'VARIABLE', handoverLeadValue, handoverLeadUnit: 'MONTHS' });
            expect(result.success).toBe(false);
            expect(result.error.issues.some(issue => issue.path[0] === 'handoverLeadValue')).toBe(true);
        },
    );

    test.each([
        [{ handoverType: 'FIXED', handoverDate: '2026-11-08' }, 'Immediate'],
        [{ handoverType: 'FIXED', handoverDate: '2026-11-09' }, '9 Nov 2026'],
        [{ handoverType: 'FIXED', handoverDate: '2028-02-29' }, '29 Feb 2028'],
        [{ handoverType: 'FIXED', handoverDate: '2028-02-29T00:00:00.000Z' }, '29 Feb 2028'],
        [{ handoverType: 'FIXED', handoverDate: new Date('2028-02-29') }, '29 Feb 2028'],
        [{ handoverType: null, handoverDate: '2028-02-29' }, '29 Feb 2028'],
        [{ handoverType: 'VARIABLE', handoverLeadValue: '2', handoverLeadUnit: 'MONTHS' }, '2 Months Post LOI'],
        [{ handoverType: 'VARIABLE', handoverLeadValue: 1, handoverLeadUnit: 'DAYS' }, '1 Day Post LOI'],
        [{ handoverType: 'VARIABLE', handoverLeadValue: 120, handoverLeadUnit: 'DAYS' }, '120 Days Post LOI'],
        [{ handoverType: 'FIXED', handoverDate: null, availability: 'Yes' }, 'Unconfirmed'],
        [{ handoverType: 'VARIABLE', handoverLeadValue: 2, handoverLeadUnit: null }, 'Unconfirmed'],
        [{ handoverType: 'VARIABLE', handoverLeadValue: null, handoverLeadUnit: 'MONTHS' }, 'Unconfirmed'],
        [{}, 'Unconfirmed'],
    ])('preserves %p through validation, serialization, and PPT formatting', (data, expected) => {
        const result = validate(data);
        expect(result.success).toBe(true);
        expect(formatHandover(result.data, NOW)).toBe(expected);
        expect(formatHandover(JSON.parse(JSON.stringify(result.data)), NOW)).toBe(expected);
        // Routes and services both validate; the second pass must accept Dates.
        expect(validate(result.data).success).toBe(true);
    });
});
