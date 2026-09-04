const StagedWarehouseModel = require('../../src/models/stagedWarehouseModel');

const REVIEWER = { email: 'reviewer@wareongo.com', name: 'Reviewer', ip: '10.0.0.1' };
const STAGED_ID = 'staged-uuid-1';

const payload = () => ({
    warehouseType: 'Industrial', city: 'Bengaluru', state: 'Karnataka',
    warehouseData: { latitude: 12.9, longitude: 77.5 },
});

/**
 * A prisma double covering only what promote() touches.
 *
 * All three staged-row writes go through `updateMany`, so they are told apart by their
 * payload: the claim sets APPROVED, the release sets PENDING, and the link sets only
 * `warehouseId`. `linkFails` makes the link throw; `linkClaimLost` makes it match zero
 * rows, which is what a concurrent reopen looks like from in here.
 */
function makePrisma({ linkFails = false, linkClaimLost = false, claimFails = false } = {}) {
    const calls = { claim: [], link: [], release: [] };

    const prisma = {
        calls,
        stagedWarehouse: {
            updateMany: jest.fn(async ({ where, data }) => {
                if (data.reviewStatus === 'APPROVED') {
                    calls.claim.push({ where, data });
                    return { count: claimFails ? 0 : 1 };
                }
                if (data.reviewStatus === 'PENDING') {
                    calls.release.push({ where, data });
                    return { count: 1 };
                }
                calls.link.push({ where, data });
                if (linkFails) throw new Error('P1001: cannot reach database server');
                return { count: linkClaimLost ? 0 : 1 };
            }),
            findUnique: jest.fn(),
        },
        warehouse: {
            create: jest.fn().mockResolvedValue({ id: 1713, WarehouseData: {} }),
            delete: jest.fn().mockResolvedValue({ id: 1713 }),
        },
        auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    return prisma;
}

describe('StagedWarehouseModel.promote', () => {
    it('claims, creates, links and audits on the happy path', async () => {
        const prisma = makePrisma();
        const model = new StagedWarehouseModel(prisma);

        const created = await model.promote(STAGED_ID, payload(), REVIEWER);

        expect(created.id).toBe(1713);
        expect(prisma.calls.link).toHaveLength(1);
        expect(prisma.calls.link[0].data).toEqual({ warehouseId: 1713 });
        expect(prisma.calls.release).toHaveLength(0);
        expect(prisma.warehouse.delete).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ action: 'APPROVE' }) }),
        );
    });

    it('refuses to promote a row it cannot claim', async () => {
        const prisma = makePrisma({ claimFails: true });
        const model = new StagedWarehouseModel(prisma);

        await expect(model.promote(STAGED_ID, payload(), REVIEWER))
            .rejects.toThrow(/not in a reviewable state/);
        expect(prisma.warehouse.create).not.toHaveBeenCalled();
    });

    it('releases the claim when the warehouse insert fails', async () => {
        const prisma = makePrisma();
        prisma.warehouse.create.mockRejectedValue(new Error('null constraint violation'));
        const model = new StagedWarehouseModel(prisma);

        await expect(model.promote(STAGED_ID, payload(), REVIEWER))
            .rejects.toThrow('null constraint violation');

        expect(prisma.calls.release).toEqual([{
            where: { id: STAGED_ID, reviewStatus: 'APPROVED', reviewedBy: REVIEWER.email },
            data: { reviewStatus: 'PENDING', reviewedBy: null, reviewedAt: null, warehouseId: null },
        }]);
    });

    it('deletes the warehouse and releases the claim when the link back fails', async () => {
        // Otherwise the warehouse is live but unreachable: reopen() skips its delete on a
        // null warehouseId, so nothing could ever pull it back.
        const prisma = makePrisma({ linkFails: true });
        const model = new StagedWarehouseModel(prisma);

        await expect(model.promote(STAGED_ID, payload(), REVIEWER))
            .rejects.toThrow(/cannot reach database server/);

        expect(prisma.warehouse.delete).toHaveBeenCalledWith({ where: { id: 1713 } });
        expect(prisma.calls.release).toHaveLength(1);
        // No approval happened, so nothing should claim one in the audit log.
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('undoes the promotion when a concurrent reopen takes the claim mid-flight', async () => {
        // A reopen between the claim and the link returns the row to PENDING and skips its
        // own warehouse delete, because it reads `warehouseId` while this is still null.
        // Linking by id alone would then leave that warehouse live and unreachable.
        const prisma = makePrisma({ linkClaimLost: true });
        const model = new StagedWarehouseModel(prisma);

        await expect(model.promote(STAGED_ID, payload(), REVIEWER))
            .rejects.toThrow(/left the approval claim/);

        expect(prisma.warehouse.delete).toHaveBeenCalledWith({ where: { id: 1713 } });
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('scopes the link write to its own claim', async () => {
        const prisma = makePrisma();
        const model = new StagedWarehouseModel(prisma);

        await model.promote(STAGED_ID, payload(), REVIEWER);

        expect(prisma.calls.link[0].where).toEqual({
            id: STAGED_ID, reviewStatus: 'APPROVED', reviewedBy: REVIEWER.email,
        });
    });

    it('clears the stale warehouse link when it releases a claim', async () => {
        // The link write can commit server-side and still surface as a connection error,
        // so the row may hold an id whose warehouse the compensation then deletes.
        const prisma = makePrisma({ linkFails: true });
        const model = new StagedWarehouseModel(prisma);

        await expect(model.promote(STAGED_ID, payload(), REVIEWER)).rejects.toThrow();

        expect(prisma.calls.release[0].data.warehouseId).toBeNull();
    });

    it('scopes the claim release to its own claim so a concurrent change is not stomped', async () => {
        const prisma = makePrisma({ linkFails: true });
        const model = new StagedWarehouseModel(prisma);

        await expect(model.promote(STAGED_ID, payload(), REVIEWER)).rejects.toThrow();

        const release = prisma.calls.release.at(-1);
        expect(release.where.reviewStatus).toBe('APPROVED');
        expect(release.where.reviewedBy).toBe(REVIEWER.email);
    });
});
