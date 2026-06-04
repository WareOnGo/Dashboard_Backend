// src/routes/staging.js
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const container = require('../container');
const ValidationMiddleware = require('../middleware/validation');
const { authMiddleware } = require('../middleware/authMiddleware');
const { verifyWebhookSecret } = require('../middleware/webhookMiddleware');
const StagingValidator = require('../validators/stagingValidator');

const stagingController = container.resolve('stagingController');

// --- Public webhook ingest (NOT admin) ---
// Registered BEFORE the admin gate below so it uses webhook-secret auth, not JWT/admin.
// Generous hourly cap as a burst backstop, not a throttle.
const ingestRateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 500,
    message: { error: 'Too many ingest requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

/**
 * POST /api/staging/ingest
 * Generic external webhook ingest. Authenticated by a shared secret in the
 * `x-webhook-secret` header (env STAGING_INGEST_SECRET). Accept-and-store: the
 * relaxed ingestSchema lets partial/messy payloads through to be reviewed; they
 * are re-validated strictly at approval. Source is tagged PARTNER_API.
 */
router.post('/ingest',
    ingestRateLimiter,
    verifyWebhookSecret,
    ValidationMiddleware.validateBody(StagingValidator.ingestSchema),
    stagingController.ingestSubmission,
);

// --- Admin-only review API (everything below) ---
// Every remaining staging route is admin-only (decided): authenticate, then require admin.
router.use(authMiddleware.authenticateJWT, authMiddleware.requireAdmin);

/**
 * GET /api/staging?reviewStatus=&page=&limit=
 * Review queue list.
 */
router.get('/',
    ValidationMiddleware.validateQuery(StagingValidator.listQuerySchema),
    stagingController.listSubmissions,
);

/**
 * GET /api/staging/:id
 */
router.get('/:id',
    ValidationMiddleware.validateParams(StagingValidator.idSchema),
    stagingController.getSubmission,
);

/**
 * PATCH /api/staging/:id
 * Reviewer edits; the row stays PENDING.
 */
router.patch('/:id',
    ValidationMiddleware.validateParams(StagingValidator.idSchema),
    ValidationMiddleware.validateBody(StagingValidator.editSchema),
    stagingController.updateSubmission,
);

/**
 * POST /api/staging/:id/approve
 * Re-validate + transactionally promote into the master Warehouse table.
 */
router.post('/:id/approve',
    ValidationMiddleware.validateParams(StagingValidator.idSchema),
    stagingController.approveSubmission,
);

/**
 * POST /api/staging/:id/reject
 */
router.post('/:id/reject',
    ValidationMiddleware.validateParams(StagingValidator.idSchema),
    ValidationMiddleware.validateBody(StagingValidator.rejectSchema),
    stagingController.rejectSubmission,
);

/**
 * POST /api/staging/:id/reopen
 * Move an approved/rejected submission back to PENDING (revoke / un-reject).
 */
router.post('/:id/reopen',
    ValidationMiddleware.validateParams(StagingValidator.idSchema),
    stagingController.reopenSubmission,
);

/**
 * DELETE /api/staging/:id
 * Delete a staged submission (does not remove a promoted master warehouse).
 */
router.delete('/:id',
    ValidationMiddleware.validateParams(StagingValidator.idSchema),
    stagingController.deleteSubmission,
);

module.exports = router;
