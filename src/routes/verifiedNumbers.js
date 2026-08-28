// src/routes/verifiedNumbers.js
const express = require('express');
const router = express.Router();
const container = require('../container');
const { authMiddleware } = require('../middleware/authMiddleware');
const ValidationMiddleware = require('../middleware/validation');
const { CAPS } = require('../utils/access');
const VerifiedNumberValidator = require('../validators/verifiedNumberValidator');

const verifiedNumberController = container.resolve('verifiedNumberController');

/**
 * Any authenticated user can read the POC list (parity with the warehouse list).
 *
 * Deliberately NOT capability-gated: the PPT config modal populates its WareOnGo
 * POC picker from this endpoint for every user, so a gate here would break export
 * for anyone without the flag.
 */
router.get('/', authMiddleware.authenticateJWT, verifiedNumberController.list);

/**
 * Admin roster management — the access-control panel.
 *
 * Gated on the ADMIN capability, which `utils/access.js` grants to anyone with
 * `adminAccess` or listed in the ADMIN_EMAILS env allowlist. There is no DELETE:
 * VerifiedNumber rows are referenced by the WhatsApp bot tables and by
 * Employee -> Ticket, so offboarding is `PATCH { is_active: false }`.
 */
const adminOnly = [
    authMiddleware.authenticateJWT,
    authMiddleware.requireAccess(CAPS.ADMIN),
];

router.get(
    '/admin',
    ...adminOnly,
    ValidationMiddleware.validateQuery(VerifiedNumberValidator.listQuerySchema),
    verifiedNumberController.adminList
);

router.post(
    '/admin',
    ...adminOnly,
    ValidationMiddleware.validateBody(VerifiedNumberValidator.createSchema),
    verifiedNumberController.adminCreate
);

router.patch(
    '/admin/:id',
    ...adminOnly,
    ValidationMiddleware.validateParams(VerifiedNumberValidator.idSchema),
    ValidationMiddleware.validateBody(VerifiedNumberValidator.updateSchema),
    verifiedNumberController.adminUpdate
);

module.exports = router;
