const { toSubmissionResult } = require('../../src/utils/submissionResult');

const stagedRow = (overrides = {}) => ({
    id: 'staged-uuid-1',
    reviewStatus: 'PENDING',
    warehouseId: null,
    source: 'SCOUT',
    submittedBy: 'scout7@wareongo.com',
    warehouseType: 'Industrial',
    city: 'Bengaluru',
    state: 'Karnataka',
    zone: 'SOUTH',
    rawPayload: { address: '1 Test Rd', warehouseData: { powerKva: '500' } },
    warehouseDeleted: false,
    ...overrides,
});

describe('toSubmissionResult', () => {
    it('reports the master warehouse id for an auto-approved submission', () => {
        const out = toSubmissionResult(stagedRow({ reviewStatus: 'APPROVED', warehouseId: 1713 }));

        expect(out.warehouseId).toBe(1713);
        expect(out.autoApproved).toBe(true);
        expect(out.reviewStatus).toBe('APPROVED');
        // The staging uuid stays addressable under both names.
        expect(out.submissionId).toBe('staged-uuid-1');
        expect(out.id).toBe('staged-uuid-1');
    });

    it('reports a null warehouse id for a submission left pending', () => {
        const out = toSubmissionResult(stagedRow());

        expect(out.warehouseId).toBeNull();
        expect(out.autoApproved).toBe(false);
        expect(out.reviewStatus).toBe('PENDING');
        expect(out.submissionId).toBe('staged-uuid-1');
    });

    it('does not claim auto-approval when APPROVED but the warehouse link is missing', () => {
        // promote()'s warehouseId link update is uncompensated, so an APPROVED row with a
        // null warehouseId is possible. The receipt must not promise a warehouse that
        // cannot be pointed at.
        const out = toSubmissionResult(stagedRow({ reviewStatus: 'APPROVED', warehouseId: null }));

        expect(out.autoApproved).toBe(false);
        expect(out.warehouseId).toBeNull();
    });

    it('echoes only the display fields, dropping the raw payload and read-time annotations', () => {
        const out = toSubmissionResult(stagedRow());

        expect(out).toEqual({
            submissionId: 'staged-uuid-1',
            id: 'staged-uuid-1',
            warehouseId: null,
            reviewStatus: 'PENDING',
            autoApproved: false,
            warehouseType: 'Industrial',
            city: 'Bengaluru',
            state: 'Karnataka',
            zone: 'SOUTH',
        });
    });

    it('nulls a missing display field rather than omitting it', () => {
        const row = stagedRow();
        delete row.zone;
        expect(toSubmissionResult(row).zone).toBeNull();
    });
});
