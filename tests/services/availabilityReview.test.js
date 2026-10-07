const WarehouseValidator = require('../../src/validators/warehouseValidator');
const WarehouseService = require('../../src/services/warehouseService');
const StagingService = require('../../src/services/stagingService');
const StagingValidator = require('../../src/validators/stagingValidator');
const { computeChanges } = require('../../src/utils/auditDiff');
const { reviewDateSchema, prepareAvailabilityUpdate, todayInIndia } = require('../../src/utils/availabilityReview');

const day = value => new Date(`${value}T00:00:00.000Z`);
const existing = () => ({ id: 7, availability: 'Yes', availabilityLastReviewedOn: day('2025-01-10'), WarehouseData: {} });

test('strict calendar validation accepts backdating, leap days, null and internal Dates', () => {
    for (const value of ['2024-02-29', '2000-01-01', day('2025-01-01')]) {
        expect(reviewDateSchema.safeParse(value).success).toBe(true);
    }
    expect(WarehouseValidator.validateUpdate({ availabilityLastReviewedOn: null }).success).toBe(true);
    expect(todayInIndia(day('2026-01-01'))).toBe('2026-01-01');
    expect(todayInIndia(new Date('2025-12-31T18:30:00Z'))).toBe('2026-01-01');
});

test.each(['2025-02-29', '2024-02-30', '2024-13-01', '01/01/2025', '2025-1-1', '0000-01-01',
    '2025-01-01T00:00:00Z', '9999-01-01', '', 0, false])('rejects invalid/future date %p', value => {
    expect(reviewDateSchema.safeParse(value).success).toBe(false);
});

test('an unchanged Yes with a new review date persists a date-only audit change', async () => {
    const before = existing();
    const model = { findById: jest.fn(async () => before), update: jest.fn(async (_id, data) => ({ ...before, ...data })) };
    const result = await new WarehouseService(model).updateWarehouse(7, {
        availability: 'Yes', availabilityLastReviewedOn: '2025-01-15', expectedAvailability: { availability: before.availability, availabilityLastReviewedOn: before.availabilityLastReviewedOn },
    });
    expect(model.update).toHaveBeenCalledWith(7, expect.objectContaining({ availabilityLastReviewedOn: day('2025-01-15') }), {
        availability: 'Yes', availabilityLastReviewedOn: before.availabilityLastReviewedOn,
    });
    expect(result.changes).toEqual([{ field: 'availabilityLastReviewedOn', from: '2025-01-10T00:00:00.000Z', to: '2025-01-15T00:00:00.000Z' }]);
    expect(model.update.mock.calls[0][1]).not.toHaveProperty('expectedAvailability');
});

test('an availability change without a date invalidates its old review', () => {
    const data = { availability: 'No' };
    expect(prepareAvailabilityUpdate(existing(), data)).toEqual({ availability: 'Yes', availabilityLastReviewedOn: day('2025-01-10') });
    expect(data.availabilityLastReviewedOn).toBeNull();
});

test.each(['2025-01-02', null])('a manual past date or explicit clear wins on a status change: %p', value => {
    const data = { availability: 'No', availabilityLastReviewedOn: value && day(value) };
    prepareAvailabilityUpdate(existing(), data);
    expect(data.availabilityLastReviewedOn).toEqual(value && day(value));
});

test('unrelated edits and spelling normalization do not refresh the date', () => {
    const unrelated = { ratePerSqft: '30' };
    expect(prepareAvailabilityUpdate(existing(), unrelated)).toBeUndefined();
    expect(unrelated).not.toHaveProperty('availabilityLastReviewedOn');
    const spelling = { availability: 'yes' };
    prepareAvailabilityUpdate(existing(), spelling);
    expect(spelling).not.toHaveProperty('availabilityLastReviewedOn');
});

test('a stale review is refused when availability changed, including date-only edits', () => {
    const current = { ...existing(), availability: 'No' };
    expect(() => prepareAvailabilityUpdate(current, { availabilityLastReviewedOn: day('2025-01-15') }, existing()))
        .toThrow('changed while this form was open');
});

test('an already saved pair is a no-op on retry', () => {
    const data = { availability: 'No', availabilityLastReviewedOn: day('2025-01-15') };
    expect(prepareAvailabilityUpdate({ ...existing(), ...data }, data, existing())).toBeUndefined();
    expect(data).toEqual({});
});

test('cannot record a review without an availability value, but can clear both', () => {
    expect(() => prepareAvailabilityUpdate({ availability: null }, { availabilityLastReviewedOn: day('2025-01-15') }))
        .toThrow('Select availability');
    const data = { availability: null };
    prepareAvailabilityUpdate(existing(), data);
    expect(data.availabilityLastReviewedOn).toBeNull();
});

test('creation defaults do not stamp a date and cannot justify a supplied review', () => {
    const service = new WarehouseService({});
    expect(service.applyCreateBusinessRules({})).not.toHaveProperty('availabilityLastReviewedOn');
    expect(() => service.applyCreateBusinessRules({ availabilityLastReviewedOn: day('2025-01-01') })).toThrow('Select availability');
});

test('staging copies the date through mapping and strips request-only controls at ingest', () => {
    const service = new StagingService({}, {});
    const result = StagingValidator.ingestSchema.parse({
        availability: 'Yes', availabilityLastReviewedOn: '2025-01-01', expectedAvailability: { availability: null, availabilityLastReviewedOn: null },
    });
    expect(result).not.toHaveProperty('expectedAvailability');
    const row = service.toStagedRow(result, { source: 'DASHBOARD', submittedBy: 'fixture@example.test' });
    expect(service.buildPromotionPayload(row).availabilityLastReviewedOn).toEqual(day('2025-01-01'));
});

test('staged edits use the same guard and include the date in the existing audit diff', async () => {
    const row = { ...existing(), reviewStatus: 'PENDING' };
    const model = { findByStagedId: async () => row, updateStaged: jest.fn(async (_id, data) => ({ ...row, ...data })) };
    const result = await new StagingService(model, {}).editSubmission('staged', {
        availabilityLastReviewedOn: day('2025-01-15'),
        expectedAvailability: { availability: row.availability, availabilityLastReviewedOn: row.availabilityLastReviewedOn },
    });
    expect(model.updateStaged.mock.calls[0][1]).not.toHaveProperty('expectedAvailability');
    expect(model.updateStaged.mock.calls[0][2]).toEqual({ availability: row.availability, availabilityLastReviewedOn: row.availabilityLastReviewedOn });
    expect(result.changes).toEqual(computeChanges(row, { availabilityLastReviewedOn: day('2025-01-15') }));
});
