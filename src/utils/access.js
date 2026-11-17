const insensitiveExact = require('./insensitiveExact');
const { isAdmin } = require('./admin');
const database = require('./database');
const LookupCache = require('./lookupCache');
const { effectiveWarehousePermissions } = require('./warehousePermissions');

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
 * instance). Warehouse reads, mutations, and admin gates bypass this cache so
 * their next request observes revocations from every instance.
 */
const CAPABILITY_TTL_MS = 30 * 1000;

const capabilityCache = new LookupCache(CAPABILITY_TTL_MS);

/**
 * Capability-based (service-based) access control.
 *
 * Access is a set of independent capabilities rather than a single role, so a user can
 * hold any combination (e.g. dashboard + reviewer but not call-dashboard). Each capability
 * maps to a boolean column on VerifiedNumber. Warehouse permissions additionally
 * depend on Dashboard and their view/own prerequisites (warehousePermissions.js).
 *
 * ADMIN is special: active, uniquely rostered env-allowlisted admins (ADMIN_EMAILS) and users with
 * adminAccess implicitly hold EVERY capability — admin implies the other capabilities but never bypasses deactivation or identity checks.
 *
 * To add a new service: add CAPS.<KEY>, a column in CAP_COLUMN + the Prisma schema, and gate
 * the routes with requireAccess(CAPS.<KEY>). No other call sites change.
 */
const CAPS = Object.freeze({
    DASHBOARD: 'DASHBOARD',
    WAREHOUSE_VIEW_OWN: 'WAREHOUSE_VIEW_OWN',
    WAREHOUSE_EDIT_OWN: 'WAREHOUSE_EDIT_OWN',
    WAREHOUSE_VIEW_ALL: 'WAREHOUSE_VIEW_ALL',
    WAREHOUSE_EDIT_ALL: 'WAREHOUSE_EDIT_ALL',
    CALL_DASHBOARD: 'CALL_DASHBOARD',
    REVIEW: 'REVIEW',
    ANALYST: 'ANALYST',
    ADMIN: 'ADMIN',
});

/** Capability -> VerifiedNumber boolean column. */
const CAP_COLUMN = Object.freeze({
    [CAPS.DASHBOARD]: 'dashboardAccess',
    [CAPS.WAREHOUSE_VIEW_OWN]: 'viewOwnWarehouseEntries',
    [CAPS.WAREHOUSE_EDIT_OWN]: 'editOwnWarehouseEntries',
    [CAPS.WAREHOUSE_VIEW_ALL]: 'viewAllWarehouseEntries',
    [CAPS.WAREHOUSE_EDIT_ALL]: 'editAllWarehouseEntries',
    [CAPS.CALL_DASHBOARD]: 'callDashboardAccess',
    [CAPS.REVIEW]: 'reviewerAccess',
    [CAPS.ANALYST]: 'analystAccess',
    [CAPS.ADMIN]: 'adminAccess',
});

const COLUMN_SELECT = Object.freeze(
    Object.values(CAP_COLUMN).reduce((acc, col) => ({ ...acc, [col]: true }), { is_active: true })
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
    if (typeof email === 'string') capabilityCache.clear(email.toLowerCase());
    else capabilityCache.clear();
}

/**
 * Resolve a user's capability set from their email.
 *
 * Returns a boolean map for every CAPS entry, including the warehouse scopes. Env-admins and
 * adminAccess users get all capabilities. A missing row or DB error yields no capabilities
 * at all, including for environment admins — i.e. least privilege / fail closed.
 *
 * @param {string} email - The authenticated user's email
 * @returns {Promise<Record<string, boolean>>}
 */
async function resolveCapabilities(email, { fresh = false } = {}) {
    if (!email || typeof email !== 'string') return allCaps(false);

    const key = email.toLowerCase();
    try {
        const load = async () => {
            const prisma = database.getClient();
            const rows = await prisma.verifiedNumber.findMany({
                // Match case-insensitively: OAuth emails are normally lowercase but the
                // stored VerifiedNumber.email may not be.
                where: { email: insensitiveExact(email) },
                select: COLUMN_SELECT,
                take: 2,
            });
            const row = rows.length === 1 ? rows[0] : null;
            const warehousePermissions = effectiveWarehousePermissions(row || {});
            const caps = !row || row.is_active !== true
                ? allCaps(false)
                : row.adminAccess === true || isAdmin(email)
                    ? allCaps(true) // DB admin implies everything
                    : {
                        [CAPS.DASHBOARD]: row.dashboardAccess === true,
                        [CAPS.WAREHOUSE_VIEW_OWN]: warehousePermissions.viewOwnWarehouseEntries,
                        [CAPS.WAREHOUSE_EDIT_OWN]: warehousePermissions.editOwnWarehouseEntries,
                        [CAPS.WAREHOUSE_VIEW_ALL]: warehousePermissions.viewAllWarehouseEntries,
                        [CAPS.WAREHOUSE_EDIT_ALL]: warehousePermissions.editAllWarehouseEntries,
                        [CAPS.CALL_DASHBOARD]: row.callDashboardAccess === true,
                        [CAPS.REVIEW]: row.reviewerAccess === true,
                        [CAPS.ANALYST]: row.analystAccess === true,
                        [CAPS.ADMIN]: false,
                    };

            // Only successful lookups are cached. A DB failure must retry on the next
            // request rather than pin "no access" for the whole TTL.
            return caps;
        };
        // Warehouse reads, administrative gates, and mutations must observe other instances
        // revoking access, even while the ordinary read cache is still warm.
        return fresh ? await load() : await capabilityCache.get(key, load);
    } catch {
        console.error('resolveCapabilities lookup failed');
        return allCaps(false); // fail closed
    }
}

/** Whether a resolved capability map grants the given capability. */
const can = (caps, capability) => !!caps?.[capability];

module.exports = { CAPS, CAP_COLUMN, resolveCapabilities, can, invalidateCapabilities };
