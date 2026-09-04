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

        it('derives zone from state when no zone is supplied (Scout form drops the field)', () => {
            const submission = { ...baseSubmission(), state: 'Maharashtra' };
            delete submission.zone;
            const row = svc.toStagedRow(submission, { source: 'SCOUT', submittedBy: scout.email });
            expect(row.zone).toBe('WEST');
        });

        it('respects a client-sent zone (dashboard form still lets users pick it)', () => {
            // Karnataka would derive to SOUTH, but the dashboard explicitly chose North.
            const submission = { ...baseSubmission(), state: 'Karnataka', zone: 'North' };
            const row = svc.toStagedRow(submission, { source: 'DASHBOARD', submittedBy: scout.email });
            expect(row.zone).toBe('North');
        });

        it('treats a blank/whitespace zone as absent and derives from state', () => {
            const submission = { ...baseSubmission(), state: 'Tamil Nadu', zone: '   ' };
            const row = svc.toStagedRow(submission, { source: 'SCOUT', submittedBy: scout.email });
            expect(row.zone).toBe('SOUTH');
        });

        it('falls back to MISC when the state is unmappable and no zone was sent', () => {
            const submission = { ...baseSubmission(), state: 'Atlantis' };
            delete submission.zone;
            const row = svc.toStagedRow(submission, { source: 'PARTNER_API', submittedBy: scout.email });
            expect(row.zone).toBe('MISC');
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

describe('maybeAutoApprove (autopilot)', () => {
    const pendingRow = () => ({
        id: 'staged-uuid-1', reviewStatus: 'PENDING', source: 'SCOUT',
        submittedBy: scout.email, city: 'Bengaluru', warehouseId: null,
    });

    /**
     * Build a service whose live collaborators are the autopilot setting, approveSubmission
     * and — on the error path only — a re-read of the row. `reread` is what
     * findByStagedId returns there; null stands for "the read failed too".
     */
    const build = ({ getAutoApprove, approveSubmission, reread = null }) => {
        const model = { findByStagedId: jest.fn().mockResolvedValue(reread) };
        const svc = new StagingService(model, {}, { getAutoApprove });
        svc.approveSubmission = approveSubmission;
        svc.model = model;
        return svc;
    };

    const validationError = () => Object.assign(new Error('bad payload'), { name: 'ValidationError' });

    it('promotes and reports the master warehouse id when autopilot is on', async () => {
        const approveSubmission = jest.fn().mockResolvedValue({ id: 1713, city: 'Bengaluru' });
        const svc = build({ getAutoApprove: jest.fn().mockResolvedValue(true), approveSubmission });

        const out = await svc.maybeAutoApprove(pendingRow());

        // The happy path takes the id straight off the insert — no second read.
        expect(svc.model.findByStagedId).not.toHaveBeenCalled();

        expect(approveSubmission).toHaveBeenCalledWith('staged-uuid-1', expect.objectContaining({
            email: 'system:auto-approve',
        }));
        expect(out.reviewStatus).toBe('APPROVED');
        expect(out.warehouseId).toBe(1713);
        expect(out.reviewedBy).toBe('system:auto-approve');
        expect(out.reviewedAt).toBeInstanceOf(Date);
        // Carried through from the staged row, not re-fetched.
        expect(out.city).toBe('Bengaluru');
    });

    it('leaves the row PENDING and never promotes when autopilot is off', async () => {
        const approveSubmission = jest.fn();
        const svc = build({ getAutoApprove: jest.fn().mockResolvedValue(false), approveSubmission });

        const row = pendingRow();
        const out = await svc.maybeAutoApprove(row);

        expect(approveSubmission).not.toHaveBeenCalled();
        expect(out).toBe(row);
    });

    it('fails safe to PENDING when the autopilot setting cannot be read', async () => {
        const approveSubmission = jest.fn();
        const svc = build({
            getAutoApprove: jest.fn().mockRejectedValue(new Error('pooler timeout')),
            approveSubmission,
        });

        const row = pendingRow();
        expect(await svc.maybeAutoApprove(row)).toBe(row);
        expect(approveSubmission).not.toHaveBeenCalled();
    });

    it('leaves the row PENDING when the payload fails strict warehouse validation', async () => {
        const svc = build({
            getAutoApprove: jest.fn().mockResolvedValue(true),
            approveSubmission: jest.fn().mockRejectedValue(validationError()),
        });

        const row = pendingRow();
        expect(await svc.maybeAutoApprove(row)).toBe(row);
    });

    it('leaves the row PENDING rather than failing the submission when promotion errors', async () => {
        // The row is already stored and promote() has released its claim, so a promotion
        // failure must degrade to "queued for review" instead of erroring the submitter.
        const svc = build({
            getAutoApprove: jest.fn().mockResolvedValue(true),
            approveSubmission: jest.fn().mockRejectedValue(new Error('P2028: transaction closed')),
        });

        const row = pendingRow();
        await expect(svc.maybeAutoApprove(row)).resolves.toBe(row);
    });

    it('reports what the row actually became when the promotion lost a race', async () => {
        // A concurrent reviewer approval makes promote() throw a conflict, but the row is
        // genuinely APPROVED and published. Reporting the stale in-memory row would tell
        // the submitter their entry is queued when it is already live.
        const conflict = Object.assign(new Error('not in a reviewable state'), { name: 'ConflictError' });
        const svc = build({
            getAutoApprove: jest.fn().mockResolvedValue(true),
            approveSubmission: jest.fn().mockRejectedValue(conflict),
            reread: { ...pendingRow(), reviewStatus: 'APPROVED', warehouseId: 1713 },
        });

        const out = await svc.maybeAutoApprove(pendingRow());

        expect(out.reviewStatus).toBe('APPROVED');
        expect(out.warehouseId).toBe(1713);
    });

    it('falls back to the in-memory row when even the re-read fails', async () => {
        // The read can fail for the same reason the promotion did, and it must not turn a
        // saved submission into an error.
        const svc = build({
            getAutoApprove: jest.fn().mockResolvedValue(true),
            approveSubmission: jest.fn().mockRejectedValue(new Error('P1001: unreachable')),
        });
        svc.model.findByStagedId.mockRejectedValue(new Error('P1001: unreachable'));

        const row = pendingRow();
        await expect(svc.maybeAutoApprove(row)).resolves.toBe(row);
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
