// src/middleware/webhookMiddleware.js
const crypto = require('crypto');

/**
 * Build a shared-secret gate for a machine-to-machine endpoint (no user/JWT, no
 * scout token), reading the expected value from `envVar` and comparing it
 * against the `x-webhook-secret` header. Properties:
 *
 *  - Fails CLOSED: if the secret is unset/blank the endpoint is treated as
 *    disabled (503) — a missing secret can never mean "allow everyone".
 *  - Constant-time comparison (crypto.timingSafeEqual) so a wrong secret leaks no timing
 *    signal about how many leading bytes matched.
 *  - Missing header and wrong secret both return a generic 401 (no oracle distinguishing them).
 *
 * Each endpoint gets its own env var so secrets can be rotated (or revoked)
 * independently — a leaked cron token must not also grant ingest.
 *
 * @param {string} envVar - Environment variable holding the expected secret
 * @param {string} featureLabel - Used in the 503 body when the secret is unset
 * @returns {Function} Express middleware
 */
const verifySharedSecret = (envVar, featureLabel) => (req, res, next) => {
    const configured = process.env[envVar];

    // Fail closed: no secret configured => feature disabled.
    if (!configured || !configured.trim()) {
        return res.status(503).json({
            error: 'Service Unavailable',
            message: `${featureLabel} is not configured.`,
        });
    }

    const provided = req.headers['x-webhook-secret'];
    if (!provided) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Missing or invalid webhook secret.',
        });
    }

    // Constant-time compare. Length differences are handled by hashing both sides to a
    // fixed-length digest first, so timingSafeEqual never throws on length mismatch.
    const a = crypto.createHash('sha256').update(String(provided)).digest();
    const b = crypto.createHash('sha256').update(String(configured)).digest();
    if (!crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Missing or invalid webhook secret.',
        });
    }

    next();
};

/**
 * Gate for the generic staging ingest endpoint (POST /api/staging/ingest),
 * authenticated by STAGING_INGEST_SECRET. On success, attaches
 * req.webhookSource = { source: 'PARTNER_API' }.
 */
const verifyWebhookSecret = (req, res, next) =>
    verifySharedSecret('STAGING_INGEST_SECRET', 'Ingest endpoint')(req, res, (err) => {
        if (err) return next(err);
        req.webhookSource = { source: 'PARTNER_API' };
        next();
    });

/** Gate for the image-label sweep, triggered by an external cron. */
const verifyCronSecret = verifySharedSecret('CRON_SECRET', 'Scheduled job endpoint');

module.exports = {
    verifyWebhookSecret,
    verifySharedSecret,
    verifyCronSecret,
};
