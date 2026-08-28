/**
 * Guard-rail tests for VerifiedNumberService.
 *
 * This service is the only writer to `VerifiedNumber` anywhere in the stack, and that
 * table is the identity/permissions record every other service reads. The rules pinned
 * here are the ones whose failure modes are silent rather than loud:
 *
 *  - a case-differing duplicate email satisfies Postgres but makes authorization
 *    non-deterministic, because utils/access.js matches case-insensitively;
 *  - the FKs on phone_number / empID cascade on update, so an unguarded edit rewrites
 *    live WhatsApp session state instead of erroring;
 *  - nothing else stops an admin from removing the last admin and locking the org out.
 */

// generateUniqueEmpId pulls the shared client directly rather than via the model.
const mockPrisma = { verifiedNumber: { findUnique: jest.fn(async () => null) } };
jest.mock('../../src/utils/database', () => ({ getClient: () => mockPrisma }));

const VerifiedNumberService = require('../../src/services/verifiedNumberService');

const ACTOR = { email: 'admin@wareongo.com', name: 'The Admin' };

/** A stored row, in the shape findByIdAdmin returns. */
const row = (overrides = {}) => ({
    id: 1,
    name: 'Asha',
    phone_number: '919800000001',
    email: 'asha@wareongo.com',
    empID: 'AB12CD',
    role: 'EMPLOYEE',
    is_active: true,
    created_at: new Date('2026-01-01T00:00:00Z'),
    twenty_user_id: null,
    adminAccess: false,
    callDashboardAccess: false,
    dashboardAccess: false,
    reviewerAccess: false,
    ...overrides,
});

function makeModel(overrides = {}) {
    return {
        listActive: jest.fn(async () => []),
        listAll: jest.fn(async () => []),
        findByIdAdmin: jest.fn(async () => row()),
        findByEmailInsensitive: jest.fn(async () => null),
        findByPhone: jest.fn(async () => null),
        findByEmpId: jest.fn(async () => null),
        countActiveAdmins: jest.fn(async () => 5),
        countDependents: jest.fn(async () => ({ whatsapp: 0, employee: 0 })),
        createOne: jest.fn(async (data) => ({ ...row(), ...data })),
        updateById: jest.fn(async (id, data) => ({ ...row(), ...data })),
        ...overrides,
    };
}

const make = (overrides) => {
    const model = makeModel(overrides);
    return { model, service: new VerifiedNumberService(model) };
};

/** Assert a rejection carries the expected HTTP status. */
async function expectStatus(promise, status) {
    await expect(promise).rejects.toMatchObject({ statusCode: status });
}

beforeEach(() => {
    mockPrisma.verifiedNumber.findUnique.mockClear();
    delete process.env.ADMIN_EMAILS;
});

describe('create', () => {
    it('generates an empID rather than trusting the caller', async () => {
        const { model, service } = make();
        const created = await service.create({ name: 'New Hire', email: 'new@wareongo.com' }, ACTOR);

        const written = model.createOne.mock.calls[0][0];
        expect(written.empID).toMatch(/^[A-Z0-9]{6}$/);
        expect(created.empID).toBe(written.empID);
    });

    it('normalizes email to lowercase and phone to the form the bot looks up', async () => {
        const { model, service } = make();
        await service.create(
            { name: 'New Hire', email: 'New.Hire@WareOnGo.com', phone_number: '+91 98000-00001' },
            ACTOR
        );

        const written = model.createOne.mock.calls[0][0];
        expect(written.email).toBe('new.hire@wareongo.com');
        expect(written.phone_number).toBe('919800000001');
    });

    it('rejects an email that differs only in case from an existing row', async () => {
        const { service } = make({
            findByEmailInsensitive: jest.fn(async () => ({ id: 9, email: 'asha@wareongo.com' })),
        });

        await expectStatus(
            service.create({ name: 'Impostor', email: 'ASHA@wareongo.com' }, ACTOR),
            409
        );
    });

    it('rejects a phone number already assigned to someone else', async () => {
        const { service } = make({ findByPhone: jest.fn(async () => ({ id: 9 })) });

        await expectStatus(
            service.create({ name: 'Dup', phone_number: '919800000001' }, ACTOR),
            409
        );
    });
});

describe('update — identity keys', () => {
    it('refuses an unconfirmed phone_number change and reports what would move', async () => {
        const { service } = make({
            countDependents: jest.fn(async () => ({ whatsapp: 4, employee: 0 })),
        });

        await expect(service.update(1, { phone_number: '919999999999' }, ACTOR)).rejects.toMatchObject({
            statusCode: 409,
            details: {
                requiresConfirmation: true,
                fields: ['phone_number'],
                dependents: { whatsapp: 4, employee: 0 },
            },
        });
    });

    it('allows the change once confirmed', async () => {
        const { model, service } = make();
        await service.update(1, { phone_number: '919999999999', confirmIdentityChange: true }, ACTOR);

        expect(model.updateById).toHaveBeenCalled();
        expect(model.updateById.mock.calls[0][1].phone_number).toBe('919999999999');
    });

    it('does not treat a same-value phone_number as a change', async () => {
        const { model, service } = make();
        // Denormalized spelling of the number already stored.
        await service.update(1, { phone_number: '+91 9800000001' }, ACTOR);

        expect(model.countDependents).not.toHaveBeenCalled();
        expect(model.updateById).toHaveBeenCalled();
    });

    it('never writes confirmIdentityChange as a column', async () => {
        const { model, service } = make();
        await service.update(1, { name: 'Asha K', confirmIdentityChange: true }, ACTOR);

        expect(model.updateById.mock.calls[0][1]).not.toHaveProperty('confirmIdentityChange');
    });
});

describe('update — lockout guards', () => {
    it('blocks an admin from removing their own admin access', async () => {
        const { service } = make({
            findByIdAdmin: jest.fn(async () => row({ email: ACTOR.email, adminAccess: true })),
        });

        await expectStatus(service.update(1, { adminAccess: false }, ACTOR), 403);
    });

    it('blocks an admin from deactivating their own row', async () => {
        const { service } = make({
            findByIdAdmin: jest.fn(async () => row({ email: ACTOR.email, adminAccess: true })),
        });

        await expectStatus(service.update(1, { is_active: false }, ACTOR), 403);
    });

    it('allows self-demotion for an ADMIN_EMAILS admin, who cannot be locked out', async () => {
        process.env.ADMIN_EMAILS = ACTOR.email;
        const { model, service } = make({
            findByIdAdmin: jest.fn(async () => row({ email: ACTOR.email, adminAccess: true })),
        });

        await service.update(1, { adminAccess: false }, ACTOR);
        expect(model.updateById).toHaveBeenCalled();
    });

    it('refuses to demote the last remaining active admin', async () => {
        const { service } = make({
            findByIdAdmin: jest.fn(async () => row({ email: 'someone@wareongo.com', adminAccess: true })),
            countActiveAdmins: jest.fn(async () => 1),
        });

        await expectStatus(service.update(1, { adminAccess: false }, ACTOR), 409);
    });

    it('allows demoting an admin while others remain', async () => {
        const { model, service } = make({
            findByIdAdmin: jest.fn(async () => row({ email: 'someone@wareongo.com', adminAccess: true })),
            countActiveAdmins: jest.fn(async () => 3),
        });

        await service.update(1, { adminAccess: false }, ACTOR);
        expect(model.updateById).toHaveBeenCalled();
    });

    it('does not run the lockout check when granting access', async () => {
        const { model, service } = make();
        await service.update(1, { reviewerAccess: true }, ACTOR);

        expect(model.countActiveAdmins).not.toHaveBeenCalled();
        expect(model.updateById).toHaveBeenCalled();
    });
});

describe('update — general', () => {
    it('404s on a missing row', async () => {
        const { service } = make({ findByIdAdmin: jest.fn(async () => null) });
        await expectStatus(service.update(404, { name: 'Ghost' }, ACTOR), 404);
    });

    it('returns a field-level diff for the audit trail, with the phone masked', async () => {
        const { service } = make();
        const { changes } = await service.update(
            1,
            { name: 'Asha Kumar', phone_number: '919999999999', confirmIdentityChange: true },
            ACTOR
        );

        const byField = Object.fromEntries(changes.map((c) => [c.field, c]));
        expect(byField.name).toMatchObject({ from: 'Asha', to: 'Asha Kumar' });
        // phone_number is in auditDiff's SENSITIVE_FIELDS, so it must never be recorded verbatim.
        expect(byField.phone_number.masked).toBe(true);
        expect(byField.phone_number.to).not.toContain('9999999');
    });

    it('lets a row keep its own email on an unrelated edit', async () => {
        const { model, service } = make({
            findByEmailInsensitive: jest.fn(async () => ({ id: 1, email: 'asha@wareongo.com' })),
        });

        await service.update(1, { email: 'Asha@wareongo.com', name: 'Asha K' }, ACTOR);
        expect(model.updateById).toHaveBeenCalled();
    });

    it('rejects a phone number that cannot be dialled', async () => {
        const { service } = make();
        await expectStatus(service.update(1, { phone_number: '000' }, ACTOR), 400);
    });
});
