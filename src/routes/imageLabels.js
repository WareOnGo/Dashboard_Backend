const express = require('express');
const container = require('../container');
const { authMiddleware } = require('../middleware/authMiddleware');
const { CAPS } = require('../utils/access');

const router = express.Router();
const controller = container.resolve('imageLabelController');

router.get('/warehouse/:id',
    authMiddleware.authenticateJWT,
    authMiddleware.requireAccess(CAPS.DASHBOARD),
    controller.byWarehouse,
);
router.get('/stats',
    authMiddleware.authenticateJWT,
    authMiddleware.requireAccess(CAPS.REVIEW),
    controller.stats,
);

module.exports = router;
