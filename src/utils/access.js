const { isAdmin } = require('./admin');
const database = require('./database');

/**
 * Capability-based (service-based) access control.
 *
 * Access is a set of independent capabilities rather than a single role, so a user can
 * hold any combination (e.g. dashboard + reviewer but not call-dashboard). Each capability
 * maps to a boolean column on VerifiedNumber; granting one is a single column flip.
 *
 * ADMIN is special: env-allowlisted admins (ADMIN_EMAILS, see utils/admin.js) and users with
 * adminAccess implicitly hold EVERY capability — admin is the master override and can never be
 * locked out by a missing flag.
 *
 * To add a new service: add CAPS.<KEY>, a column in CAP_COLUMN + the Prisma schema, and gate
 * the routes with requireAccess(CAPS.<KEY>). No other call sites change.
 */
const CAPS = Object.freeze({
    DASHBOARD: 'DASHBOARD',
    CALL_DASHBOARD: 'CALL_DASHBOARD',
    REVIEW: 'REVIEW',
    ADMIN: 'ADMIN',
});

/** Capability -> VerifiedNumber boolean column. */
const CAP_COLUMN = Object.freeze({
    [CAPS.DASHBOARD]: 'dashboardAccess',
    [CAPS.CALL_DASHBOARD]: 'callDashboardAccess',
    [CAPS.REVIEW]: 'reviewerAccess',
    [CAPS.ADMIN]: 'adminAccess',
});

const COLUMN_SELECT = Object.freeze(
    Object.values(CAP_COLUMN).reduce((acc, col) => ({ ...acc, [col]: true }), {})
);

/** A capability map with every capability set to `value`. */
const allCaps = (value) =>
    Object.values(CAPS).reduce((acc, cap) => ({ ...acc, [cap]: value }), {});

/**
 * Resolve a user's capability set from their email.
 *
 * Returns a plain map { DASHBOARD, CALL_DASHBOARD, REVIEW, ADMIN } of booleans. Env-admins and
 * adminAccess users get all capabilities. A missing row or DB error yields no capabilities
 * beyond any env-admin grant — i.e. least privilege / fail closed.
 *
 * @param {string} email - The authenticated user's email
 * @returns {Promise<Record<string, boolean>>}
 */
async function resolveCapabilities(email) {
    if (isAdmin(email)) return allCaps(true); // env master override
    if (!email || typeof email !== 'string') return allCaps(false);

    try {
        const prisma = database.getClient();
        const row = await prisma.verifiedNumber.findFirst({
            // Match case-insensitively: OAuth emails are normally lowercase but the
            // stored VerifiedNumber.email may not be.
            where: { email: { equals: email, mode: 'insensitive' } },
            select: COLUMN_SELECT,
        });
        if (!row) return allCaps(false);

        if (row.adminAccess) return allCaps(true); // DB admin implies everything

        return {
            [CAPS.DASHBOARD]: !!row.dashboardAccess,
            [CAPS.CALL_DASHBOARD]: !!row.callDashboardAccess,
            [CAPS.REVIEW]: !!row.reviewerAccess,
            [CAPS.ADMIN]: false,
        };
    } catch (err) {
        console.error('resolveCapabilities lookup failed:', err.message);
        return allCaps(false); // fail closed
    }
}

/** Whether a resolved capability map grants the given capability. */
const can = (caps, capability) => !!caps?.[capability];

module.exports = { CAPS, CAP_COLUMN, resolveCapabilities, can };
