// src/routes/imageLabels.js
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const container = require('../container');
const { authMiddleware } = require('../middleware/authMiddleware');
const { CAPS } = require('../utils/access');
const { verifyCronSecret } = require('../middleware/webhookMiddleware');

const imageLabelController = container.resolve('imageLabelController');

/**
 * Burst backstop, not a throttle. A sane cron pokes this every few minutes; this
 * cap only stops a misconfigured one (or a leaked secret) from spending money in
 * a loop.
 */
const sweepRateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 120,
    message: { error: 'Too many sweep requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

/**
 * POST /api/image-labels/sweep
 *
 * Forward-fill: classify warehouse images that have no label row yet. Intended
 * to be hit by an external cron. Authenticated by a shared secret in the
 * `x-webhook-secret` header (env CRON_SECRET) — registered BEFORE the JWT gate
 * below so it uses secret auth, not a user session.
 *
 * Bounded per call (default 150 images, max 500) so it returns well inside any
 * proxy timeout. The response includes `remaining`; if a backlog is draining,
 * poke it again rather than raising the limit.
 *
 * Always 200 on a healthy call — including status: 'SKIPPED' when another sweep
 * is already in flight, so a cron does not alert on normal overlap.
 */
router.post('/sweep',
    sweepRateLimiter,
    verifyCronSecret,
    imageLabelController.sweep,
);

/**
 * GET /api/image-labels/warehouse/:id
 *
 * Labels for one warehouse's images. Gated by JWT only — deliberately matching
 * GET /api/warehouses, since anyone who can see a listing can see how its own
 * photos were categorised. Registered before the REVIEW gate below.
 */
router.get('/warehouse/:id',
    authMiddleware.authenticateJWT,
    imageLabelController.byWarehouse,
);

// --- Everything below is ops-facing (JWT + REVIEW capability) ---
router.use(authMiddleware.authenticateJWT, authMiddleware.requireAccess(CAPS.REVIEW));

/**
 * GET /api/image-labels/stats
 * Coverage, label distribution and recent sweep history, for the review panel.
 */
router.get('/stats', imageLabelController.stats);

module.exports = router;
