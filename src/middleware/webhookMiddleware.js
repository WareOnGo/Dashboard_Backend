// src/middleware/webhookMiddleware.js
const crypto = require('crypto');

/**
 * Verify a webhook caller via a shared secret in the `x-webhook-secret` header,
 * compared against the STAGING_INGEST_SECRET environment variable.
 *
 * Used to authenticate the generic staging ingest endpoint (POST /api/staging/ingest),
 * which has no user/JWT and no scout token. Properties:
 *
 *  - Fails CLOSED: if STAGING_INGEST_SECRET is unset/blank, the endpoint is treated as
 *    disabled (503) — a missing secret can never mean "allow everyone".
 *  - Constant-time comparison (crypto.timingSafeEqual) so a wrong secret leaks no timing
 *    signal about how many leading bytes matched.
 *  - Missing header and wrong secret both return a generic 401 (no oracle distinguishing them).
 *
 * On success, attaches req.webhookSource = { source: 'PARTNER_API' }.
 */
const verifyWebhookSecret = (req, res, next) => {
    const configured = process.env.STAGING_INGEST_SECRET;

    // Fail closed: no secret configured => feature disabled.
    if (!configured || !configured.trim()) {
        return res.status(503).json({
            error: 'Service Unavailable',
            message: 'Ingest endpoint is not configured.',
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

    req.webhookSource = { source: 'PARTNER_API' };
    next();
};

module.exports = {
    verifyWebhookSecret,
};
