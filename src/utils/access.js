const { isAdmin } = require('./admin');
const database = require('./database');

/**
 * How long a resolved capability set is trusted, in ms.
 *
 * Every gated request resolves capabilities, which was one DB round trip per
 * request. That was tolerable while only the review panel was gated; once the
 * main dashboard is, the same query sits in front of every page load, and a
 * momentary DB failure logs the whole company out (resolveCapabilities fails
 * closed by design). A short TTL keeps that window small without making the
 * lookup a per-request cost.
 *
 * Writes made through the admin panel invalidate the entry immediately, so the
 * TTL only bounds staleness for changes made out-of-band (direct SQL, another
 * instance). Kept short for that reason: a revoke must not linger.
 */
const CAPABILITY_TTL_MS = 30 * 1000;

/** email (lowercased) -> { caps, at } */
const capabilityCache = new Map();

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
 * Drop a cached capability set so the next request re-reads from the DB.
 * Called with no argument, clears the whole cache.
 * @param {string} [email]
 */
function invalidateCapabilities(email) {
    if (typeof email === 'string') capabilityCache.delete(email.toLowerCase());
    else capabilityCache.clear();
}

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

    const key = email.toLowerCase();
    const hit = capabilityCache.get(key);
    if (hit && Date.now() - hit.at < CAPABILITY_TTL_MS) return hit.caps;

    try {
        const prisma = database.getClient();
        const row = await prisma.verifiedNumber.findFirst({
            // Match case-insensitively: OAuth emails are normally lowercase but the
            // stored VerifiedNumber.email may not be.
            where: { email: { equals: email, mode: 'insensitive' } },
            select: COLUMN_SELECT,
        });
        const caps = !row
            ? allCaps(false)
            : row.adminAccess
                ? allCaps(true) // DB admin implies everything
                : {
                    [CAPS.DASHBOARD]: !!row.dashboardAccess,
                    [CAPS.CALL_DASHBOARD]: !!row.callDashboardAccess,
                    [CAPS.REVIEW]: !!row.reviewerAccess,
                    [CAPS.ADMIN]: false,
                };

        // Only successful lookups are cached. A DB failure must retry on the next
        // request rather than pin "no access" for the whole TTL.
        capabilityCache.set(key, { caps, at: Date.now() });
        return caps;
    } catch (err) {
        console.error('resolveCapabilities lookup failed:', err.message);
        return allCaps(false); // fail closed
    }
}

/** Whether a resolved capability map grants the given capability. */
const can = (caps, capability) => !!caps?.[capability];

module.exports = { CAPS, CAP_COLUMN, resolveCapabilities, can, invalidateCapabilities };
