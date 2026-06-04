const { Prisma } = require('@prisma/client');
const StagingService = require('../../src/services/stagingService');
const WarehouseValidator = require('../../src/validators/warehouseValidator');

// Pure-logic tests: the mapping helpers don't touch the DB, so a bare instance is fine.
const svc = new StagingService(/* model */ {}, /* warehouseService */ {});

const scout = { id: 7, empid: 'EMP7', name: 'Scout Seven', email: 'scout7@wareongo.com' };

const baseSubmission = () => ({
    warehouseType: 'Industrial', address: '1 Test Rd', city: 'Bengaluru', state: 'Karnataka',
    zone: 'South', contactPerson: 'Tester', contactNumber: '9999999999',
    totalSpaceSqft: [10000], compliances: 'CLU', ratePerSqft: '25', uploadedBy: 'ignored',
    warehouseData: { latitude: 12.9, longitude: 77.5, powerKva: '500' },
});

describe('StagingService mapping', () => {
    describe('toStagedRow', () => {
        it('flattens nested warehouseData and forces source-identity fields', () => {
            const submission = { ...baseSubmission(), wogVerified: true, visibility: true };
            const row = svc.toStagedRow(submission, { source: 'SCOUT', submittedBy: scout.email });

            expect(row.source).toBe('SCOUT');
            expect(row.submittedBy).toBe(scout.email);
            expect(row.reviewStatus).toBe('PENDING');
            // flattened from nested warehouseData
            expect(row.latitude).toBe(12.9);
            expect(row.powerKva).toBe('500');
            expect(row.warehouseData).toBeUndefined();
            // forced fields win over the submission
            expect(row.uploadedBy).toBe(scout.email);
            expect(row.wogVerified).toBe(false);
            expect(row.visibility).toBe(false);
            // raw snapshot preserved (with nesting)
            expect(row.rawPayload.warehouseData.powerKva).toBe('500');
        });
    });

    describe('buildPromotionPayload', () => {
        it('re-nests warehouseData and drops pipeline metadata', () => {
            const flatRow = {
                id: 'uuid-1', reviewStatus: 'IN_REVIEW', source: 'SCOUT', submittedBy: scout.email,
                submittedAt: new Date(), reviewedBy: null, reviewedAt: null, rejectionReason: null,
                warehouseId: null, rawPayload: {}, flags: null, reviewMeta: null,
                city: 'Bengaluru', ratePerSqft: '30', latitude: 12.9, powerKva: '750',
            };
            const payload = svc.buildPromotionPayload(flatRow);

            expect(payload.city).toBe('Bengaluru');
            expect(payload.ratePerSqft).toBe('30');
            expect(payload.warehouseData.latitude).toBe(12.9);
            expect(payload.warehouseData.powerKva).toBe('750');
            // metadata must not leak into the warehouse payload
            for (const meta of ['id', 'reviewStatus', 'source', 'submittedBy', 'warehouseId', 'rawPayload', 'flags', 'reviewMeta']) {
                expect(payload[meta]).toBeUndefined();
            }
        });
    });

    describe('computeDiff', () => {
        it('reports only changed fields, including arrays', () => {
            const row = { ratePerSqft: '25', city: 'Bengaluru', totalSpaceSqft: [10000] };
            const changes = svc.computeDiff(row, { ratePerSqft: '30', city: 'Bengaluru', totalSpaceSqft: [20000] });
            const fields = changes.map((c) => c.field).sort();
            expect(fields).toEqual(['ratePerSqft', 'totalSpaceSqft']);
            const rate = changes.find((c) => c.field === 'ratePerSqft');
            expect(rate).toEqual({ field: 'ratePerSqft', from: '25', to: '30' });
        });
    });

    describe('flattenForMirror', () => {
        it('flattens nested data and strips metadata keys', () => {
            const out = svc.flattenForMirror({
                ratePerSqft: '30', reviewStatus: 'APPROVED', warehouseId: 5,
                warehouseData: { powerKva: '750' },
            });
            expect(out).toEqual({ ratePerSqft: '30', powerKva: '750' });
        });
    });
});

describe('StagedWarehouse mirror drift', () => {
    const columns = new Set(
        Prisma.dmmf.datamodel.models.find((m) => m.name === 'StagedWarehouse').fields.map((f) => f.name),
    );

    it('mirrors every top-level createWarehouseSchema field', () => {
        const fields = Object.keys(WarehouseValidator.createWarehouseSchema.shape)
            .filter((k) => k !== 'warehouseData');
        const missing = fields.filter((f) => !columns.has(f));
        expect(missing).toEqual([]);
    });

    it('mirrors every nested warehouseData field', () => {
        const fields = Object.keys(WarehouseValidator.warehouseDataSchema.shape);
        const missing = fields.filter((f) => !columns.has(f));
        expect(missing).toEqual([]);
    });
});
