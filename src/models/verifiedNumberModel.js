// src/models/verifiedNumberModel.js
const BaseModel = require('./baseModel');

/**
 * Columns exposed to the admin panel. `VerifiedNumber` is the identity table for
 * the whole stack, so the admin view selects everything an admin can reason about
 * — including the capability booleans and the identity keys other services join on.
 */
const ADMIN_SELECT = Object.freeze({
    id: true,
    name: true,
    phone_number: true,
    email: true,
    empID: true,
    role: true,
    is_active: true,
    created_at: true,
    twenty_user_id: true,
    adminAccess: true,
    callDashboardAccess: true,
    dashboardAccess: true,
    reviewerAccess: true,
});

/**
 * VerifiedNumberModel — WareOnGo staff / points-of-contact whose numbers are
 * verified. Used to populate POC pickers (e.g. the PPT generator) and, through
 * the admin routes, to manage dashboard access.
 */
class VerifiedNumberModel extends BaseModel {
    constructor(prismaClient = null) {
        super(prismaClient);
        this.model = this.prisma.verifiedNumber;
    }

    /**
     * List active verified numbers as lightweight { id, name, phone_number, email }
     * rows, ordered by name. Only fields needed for a POC dropdown are selected;
     * email lets the client preselect the logged-in user's own entry.
     * @returns {Promise<Array<{ id: number, name: string, phone_number: string, email: string|null }>>}
     */
    listActive() {
        return this.model.findMany({
            where: { is_active: true },
            select: { id: true, name: true, phone_number: true, email: true },
            orderBy: { name: 'asc' },
        });
    }

    /**
     * Full roster for the admin panel.
     *
     * Deliberately unpaginated: this table holds the staff roster (tens of rows,
     * not thousands), and an admin managing access wants the whole list in front
     * of them. Revisit if it ever grows past a few hundred.
     *
     * @param {Object} [options]
     * @param {string} [options.search] - Case-insensitive match on name/email/phone/empID
     * @param {boolean} [options.includeInactive=false] - Include deactivated rows
     * @returns {Promise<Array<Object>>}
     */
    listAll({ search, includeInactive = false } = {}) {
        const where = {};
        if (!includeInactive) where.is_active = true;

        const term = typeof search === 'string' ? search.trim() : '';
        if (term) {
            where.OR = [
                { name: { contains: term, mode: 'insensitive' } },
                { email: { contains: term, mode: 'insensitive' } },
                { phone_number: { contains: term } },
                { empID: { contains: term, mode: 'insensitive' } },
            ];
        }

        return this.model.findMany({
            where,
            select: ADMIN_SELECT,
            orderBy: { name: 'asc' },
        });
    }

    /** A single row in admin shape, by integer id. @returns {Promise<Object|null>} */
    findByIdAdmin(id) {
        return this.model.findUnique({
            where: { id: parseInt(id, 10) },
            select: ADMIN_SELECT,
        });
    }

    /**
     * Case-insensitive email lookup.
     *
     * The unique index on `email` is case-sensitive, but `utils/access.js` resolves
     * capabilities case-insensitively — so two rows differing only in case would both
     * satisfy Postgres while making authorization non-deterministic. This is the check
     * that keeps that from happening.
     * @returns {Promise<{id: number, email: string|null}|null>}
     */
    findByEmailInsensitive(email) {
        return this.model.findFirst({
            where: { email: { equals: email, mode: 'insensitive' } },
            select: { id: true, email: true },
        });
    }

    /** @returns {Promise<{id: number}|null>} */
    findByPhone(phone_number) {
        return this.model.findUnique({
            where: { phone_number },
            select: { id: true },
        });
    }

    /** @returns {Promise<{id: number}|null>} */
    findByEmpId(empID) {
        return this.model.findUnique({
            where: { empID },
            select: { id: true },
        });
    }

    /** Number of active rows holding adminAccess — guards the last-admin rule. */
    countActiveAdmins() {
        return this.model.count({ where: { is_active: true, adminAccess: true } });
    }

    /**
     * Count rows in other tables that join this row's identity keys, so an edit to
     * `phone_number` / `empID` can be reported before it silently cascades.
     * @param {{ phone_number?: string, empID?: string|null }} row
     * @returns {Promise<{ whatsapp: number, employee: number }>}
     */
    async countDependents({ phone_number, empID }) {
        const [agentSessions, conversations, mediaContexts, reminders, tasks, employees] =
            await Promise.all([
                phone_number ? this.prisma.agent_session.count({ where: { sender_number: phone_number } }) : 0,
                phone_number ? this.prisma.conversation.count({ where: { sender_number: phone_number } }) : 0,
                phone_number ? this.prisma.media_context.count({ where: { sender_number: phone_number } }) : 0,
                phone_number ? this.prisma.reminder.count({ where: { sender_number: phone_number } }) : 0,
                phone_number ? this.prisma.task.count({ where: { sender_number: phone_number } }) : 0,
                empID ? this.prisma.employee.count({ where: { empID } }) : 0,
            ]);

        return {
            whatsapp: agentSessions + conversations + mediaContexts + reminders + tasks,
            employee: employees,
        };
    }

    /** Create a row, returning it in admin shape. */
    createOne(data) {
        return this.model.create({ data, select: ADMIN_SELECT });
    }

    /** Update a row by integer id, returning it in admin shape. */
    updateById(id, data) {
        return this.model.update({
            where: { id: parseInt(id, 10) },
            data,
            select: ADMIN_SELECT,
        });
    }
}

module.exports = VerifiedNumberModel;
module.exports.ADMIN_SELECT = ADMIN_SELECT;
