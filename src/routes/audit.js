// src/routes/audit.js
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const container = require('../container');
const ValidationMiddleware = require('../middleware/validation');
const { authMiddleware } = require('../middleware/authMiddleware');
const AuditValidator = require('../validators/auditValidator');

const auditController = container.resolve('auditController');

/**
 * Generous cap: a busy day of legitimate exporting stays well under it, while
 * nothing can flood audit_logs from one address.
 */
const pptExportRateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 300,
    message: { error: 'Too many export reports, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

/**
 * POST /api/audit/ppt-export
 *
 * Client-reported PPT export. Deliberately narrow: this is NOT a general
 * "write an audit row" endpoint. `action` and `entity` are hardcoded in the
 * controller and the acting user comes from the JWT, so reaching this route
 * cannot produce a row that impersonates another user or another action.
 *
 * No requireAccess() gate — anyone who can reach the dashboard can export,
 * so anyone who can reach it can report having done so.
 */
router.post('/ppt-export',
    authMiddleware.authenticateJWT,
    pptExportRateLimiter,
    ValidationMiddleware.validateBody(AuditValidator.pptExportSchema),
    auditController.logPptExport,
);

module.exports = router;
