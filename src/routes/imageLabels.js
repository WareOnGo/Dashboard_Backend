const express = require('express');
const container = require('../container');
const { authMiddleware } = require('../middleware/authMiddleware');
const { CAPS } = require('../utils/access');
const { requireWarehouseEntry } = require('../middleware/warehouseAccess');

const router = express.Router();
const controller = container.resolve('imageLabelController');

router.get('/warehouse/:id',
    authMiddleware.authenticateJWT,
    authMiddleware.requireAccess(CAPS.WAREHOUSE_VIEW_OWN),
    requireWarehouseEntry(),
    controller.byWarehouse,
);
router.get('/stats',
    authMiddleware.authenticateJWT,
    authMiddleware.requireAccess(CAPS.REVIEW),
    controller.stats,
);

module.exports = router;
