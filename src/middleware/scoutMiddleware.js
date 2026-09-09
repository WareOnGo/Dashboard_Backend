// src/middleware/scoutMiddleware.js
const database = require('../utils/database');

/**
 * How long a successful empID verification stays cached, in milliseconds.
 *
 * A scout submission asks for one presigned URL per media file, and every one
 * of those requests used to run its own VerifiedNumber lookup. A 30-file
 * submission therefore opened 30 database connections in the same burst, which
 * exhausted the Supabase pooler (EMAXCONNSESSION) and failed the upload with a
 * 500. Caching the lookup collapses a whole submission onto a single query.
 *
 * The trade-off is revocation lag: a scout whose access is revoked keeps
 * working until their cache entry expires. Keep this short.
 */
const VERIFY_CACHE_TTL_MS = 60 * 1000;

/**
 * empID -> { scout, expiresAt }. Only successful verifications are cached;
 * unknown or revoked empIDs always re-query so that granting access takes
 * effect immediately.
 * @type {Map<string, { scout: Object, expiresAt: number }>}
 */
const verifyCache = new Map();

/**
 * Drop expired entries so the map cannot grow without bound.
 */
const pruneCache = (now) => {
    for (const [key, entry] of verifyCache) {
        if (entry.expiresAt <= now) verifyCache.delete(key);
    }
};

/**
 * Clear the verification cache. Call after changing a scout's access so the
 * change is picked up without waiting for the TTL.
 */
const clearScoutCache = (empID) => {
    if (empID) verifyCache.delete(String(empID).trim().toUpperCase());
    else verifyCache.clear();
};

/**
 * Middleware to verify a scout's empID against the VerifiedNumber table.
 * Token comes in via req.body.uploadedBy or the x-scout-token header.
 * On success, attaches req.scout with { id, empid, name, email, status } so
 * downstream controllers can keep using their existing field names.
 */
const verifyScoutToken = async (req, res, next) => {
    const rawEmpId = req.body?.uploadedBy || req.headers['x-scout-token'];

    if (!rawEmpId) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Scout token (empID) is missing. Please provide your Employee ID in the uploadedBy field.'
        });
    }

    const empID = String(rawEmpId).trim().toUpperCase();

    const now = Date.now();
    const cached = verifyCache.get(empID);
    if (cached && cached.expiresAt > now) {
        req.scout = cached.scout;
        return next();
    }

    let verified;
    try {
        verified = await database.getClient().verifiedNumber.findUnique({
            where: { empID }
        });
    } catch (error) {
        // A database failure is not an authentication failure. Reporting it as
        // a 500 "failed to verify scout token" sent callers looking for a bad
        // employee ID when the real cause was pooler exhaustion.
        console.error('Scout token verification could not reach the database:', error);
        return res.status(503).json({
            error: 'Service Unavailable',
            message: 'Could not verify your Scout access right now. Please retry in a moment.',
            retryable: true
        });
    }

    if (!verified) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Invalid Scout token (empID).'
        });
    }

    if (!verified.is_active) {
        return res.status(403).json({
            error: 'Forbidden',
            message: 'Your Scout access has been revoked. Please contact administration.'
        });
    }

    const scout = {
        id: verified.id,
        empid: verified.empID,
        name: verified.name,
        email: verified.email,
        status: 'ACTIVE',
    };

    pruneCache(now);
    verifyCache.set(empID, { scout, expiresAt: now + VERIFY_CACHE_TTL_MS });

    req.scout = scout;
    next();
};

module.exports = {
    verifyScoutToken,
    clearScoutCache,
    VERIFY_CACHE_TTL_MS
};
