// src/services/verifiedNumberService.js
const BaseService = require('./baseService');
const { computeChanges } = require('../utils/auditDiff');
const { normalizePhone } = require('./gupshupService');
const { generateUniqueEmpId } = require('../utils/empIdGenerator');
const { isAdmin } = require('../utils/admin');
const { invalidateCapabilities } = require('../utils/access');
const database = require('../utils/database');

const clientError = (message, statusCode, details = null) => {
    const err = new Error(message);
    err.statusCode = statusCode;
    if (details) err.details = details;
    return err;
};

/** Columns whose edit cascades outside this backend. See countDependents(). */
const IDENTITY_KEYS = Object.freeze(['phone_number', 'empID']);

/** Capability columns an admin can toggle. */
const CAPABILITY_COLUMNS = Object.freeze([
    'adminAccess',
    'callDashboardAccess',
    'dashboardAccess',
    'reviewerAccess',
]);

const sameEmail = (a, b) =>
    typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * VerifiedNumberService — admin management of the staff roster and dashboard access.
 *
 * This is the only writer to `VerifiedNumber` anywhere in the stack, which is why the
 * safety rules live here rather than in the controller:
 *
 *  - `email` is how utils/access.js resolves capabilities, and its unique index is
 *    case-sensitive while that lookup is case-insensitive — so duplicates that differ
 *    only in case are rejected explicitly.
 *  - `phone_number` and `empID` are joined by tables this backend does not own (the
 *    WhatsApp bot's session tables, and Employee -> Ticket). Those FKs cascade on
 *    update, so an edit does not fail loudly — it silently rewrites live state. Hence
 *    the explicit confirmation gate.
 *  - Admins must not be able to lock the organization out of this panel, hence the
 *    self-demotion and last-admin rules.
 *
 * Single-statement operations only (no interactive transactions) to stay safe on the
 * Supabase pooler.
 */
class VerifiedNumberService extends BaseService {
    /**
     * @param {VerifiedNumberModel} verifiedNumberModel
     */
    constructor(verifiedNumberModel) {
        super();
        this.verifiedNumberModel = verifiedNumberModel;
    }

    /** POC dropdown list — unchanged, JWT-only callers. */
    listActive() {
        return this.executeOperation(() => this.verifiedNumberModel.listActive());
    }

    /** Full roster for the admin panel. */
    list({ search, includeInactive } = {}) {
        return this.executeOperation(() =>
            this.verifiedNumberModel.listAll({ search, includeInactive })
        );
    }

    /**
     * Normalize the identity columns to the forms other consumers expect.
     * Mutates nothing: returns a new payload.
     * @private
     */
    normalize(payload) {
        const data = { ...payload };

        if (typeof data.email === 'string') data.email = data.email.trim().toLowerCase();
        if (typeof data.empID === 'string') data.empID = data.empID.trim().toUpperCase();

        if (typeof data.phone_number === 'string') {
            // Reuse the notifier's normalizer so stored numbers match the form the
            // WhatsApp bot looks rows up by (E.164 without the plus, e.g. 91XXXXXXXXXX).
            const phone = normalizePhone(data.phone_number);
            if (!phone) throw clientError('phone_number is not a valid dialable number', 400);
            data.phone_number = phone;
        }

        return data;
    }

    /**
     * Reject values that already belong to another row.
     * @param {Object} data - Normalized payload
     * @param {number|null} excludeId - Row being updated, exempt from the check
     * @private
     */
    async assertUnique(data, excludeId = null) {
        const conflicts = [];

        if (data.email != null) {
            const row = await this.verifiedNumberModel.findByEmailInsensitive(data.email);
            if (row && row.id !== excludeId) {
                conflicts.push(
                    `email "${data.email}" is already assigned to another employee` +
                        (row.email !== data.email ? ` (stored as "${row.email}")` : '')
                );
            }
        }

        if (data.phone_number != null) {
            const row = await this.verifiedNumberModel.findByPhone(data.phone_number);
            if (row && row.id !== excludeId) {
                conflicts.push(`phone number "${data.phone_number}" is already assigned to another employee`);
            }
        }

        if (data.empID != null) {
            const row = await this.verifiedNumberModel.findByEmpId(data.empID);
            if (row && row.id !== excludeId) {
                conflicts.push(`employee ID "${data.empID}" is already assigned to another employee`);
            }
        }

        if (conflicts.length) throw clientError(conflicts.join('; '), 409);
    }

    /**
     * Block changes that could lock the organization out of the admin panel.
     * @param {Object} existing - The row as stored
     * @param {Object} data - Normalized edits
     * @param {{email: string}} actor - The acting admin
     * @private
     */
    async assertNotLockingOut(existing, data, actor) {
        const losesAdmin =
            (data.adminAccess === false && existing.adminAccess) ||
            (data.is_active === false && existing.adminAccess);

        if (!losesAdmin) return;

        // An env-allowlisted admin (ADMIN_EMAILS) draws access from the environment,
        // so editing their own row cannot lock them out.
        if (sameEmail(existing.email, actor?.email) && !isAdmin(actor?.email)) {
            throw clientError(
                'You cannot remove your own admin access. Ask another admin to do it.',
                403
            );
        }

        const activeAdmins = await this.verifiedNumberModel.countActiveAdmins();
        if (activeAdmins <= 1) {
            throw clientError(
                'This is the last active admin. Grant admin access to someone else first.',
                409
            );
        }
    }

    /**
     * Guard edits to columns other services join on. These FKs cascade on update, so
     * without this the write would succeed and quietly move live WhatsApp sessions and
     * invalidate the person's Scout login.
     * @private
     */
    async assertIdentityChangeConfirmed(existing, data, confirmed) {
        const changing = IDENTITY_KEYS.filter(
            (key) => data[key] !== undefined && data[key] !== existing[key]
        );
        if (!changing.length || confirmed) return;

        const dependents = await this.verifiedNumberModel.countDependents({
            phone_number: changing.includes('phone_number') ? existing.phone_number : null,
            empID: changing.includes('empID') ? existing.empID : null,
        });

        throw clientError(
            `Changing ${changing.join(' and ')} will also move linked records. ` +
                'Re-send with confirmIdentityChange: true to proceed.',
            409,
            { requiresConfirmation: true, fields: changing, dependents }
        );
    }

    /**
     * Add a new employee to the roster.
     * @param {Object} payload - Validated create body
     * @param {{email: string, name: string}} actor
     * @returns {Promise<Object>} The created row in admin shape
     */
    create(payload, actor) {
        return this.executeOperation(async () => {
            const data = this.normalize(payload);
            await this.assertUnique(data);

            // First real use of the generator: every employee gets a stable empID so
            // Scout login and the reimbursement portal can reference them later.
            data.empID = await generateUniqueEmpId(database.getClient());

            try {
                const created = await this.verifiedNumberModel.createOne(data);
                // A brand-new row can already be cached as "no access" if that email
                // was refused a moment ago, so drop the entry rather than wait it out.
                invalidateCapabilities(created.email);
                return created;
            } catch (err) {
                if (err.code === 'P2002') {
                    throw clientError(
                        `An employee with that ${err.meta?.target ?? 'identifier'} already exists`,
                        409
                    );
                }
                throw err;
            }
        });
    }

    /**
     * Edit an employee's details or capabilities.
     * @param {number} id
     * @param {Object} payload - Validated update body
     * @param {{email: string, name: string}} actor
     * @returns {Promise<{row: Object, changes: Array}>} Updated row plus the audit diff
     */
    update(id, payload, actor) {
        return this.executeOperation(async () => {
            const { confirmIdentityChange, ...edits } = payload;

            const existing = await this.verifiedNumberModel.findByIdAdmin(id);
            if (!existing) throw clientError(`Employee with ID ${id} not found`, 404);

            const data = this.normalize(edits);

            await this.assertIdentityChangeConfirmed(existing, data, confirmIdentityChange === true);
            await this.assertNotLockingOut(existing, data, actor);
            await this.assertUnique(data, existing.id);

            // Diff before the write, against the normalized payload, so the audit trail
            // records the values actually persisted rather than the raw request body.
            const changes = computeChanges(existing, data);

            try {
                const row = await this.verifiedNumberModel.updateById(id, data);
                // Grants and revokes must take effect on the next request, not after
                // the capability TTL. Both addresses matter when the email changed.
                invalidateCapabilities(existing.email);
                invalidateCapabilities(row.email);
                return { row, changes };
            } catch (err) {
                if (err.code === 'P2025') throw clientError(`Employee with ID ${id} not found`, 404);
                if (err.code === 'P2002') {
                    throw clientError(
                        `An employee with that ${err.meta?.target ?? 'identifier'} already exists`,
                        409
                    );
                }
                throw err;
            }
        });
    }
}

module.exports = VerifiedNumberService;
module.exports.CAPABILITY_COLUMNS = CAPABILITY_COLUMNS;
module.exports.IDENTITY_KEYS = IDENTITY_KEYS;
