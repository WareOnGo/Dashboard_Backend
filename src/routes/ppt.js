// src/routes/ppt.js
const express = require('express');
const router = express.Router();
const container = require('../container');
const { authMiddleware } = require('../middleware/authMiddleware');
const { CAPS } = require('../utils/access');

const pptController = container.resolve('pptController');

/**
 * Warehouse proposal exports require WAREHOUSE_VIEW_OWN. The controller checks
 * every selected row against the same own/all scope as the dashboard before
 * generating a file. Run migrateWarehousePermissions.js before deploying this
 * gate so current employees retain their existing access.
 *
 * Paths stay flat under /api to preserve the frontend's existing URLs.
 */
// Applied per-route rather than via router.use(): this router is mounted flat
// at /api, so router-level middleware would also run for every unmatched /api/*
// path and turn what should be a 404 into a 401.
const gate = [authMiddleware.authenticateJWT, authMiddleware.requireAccess(CAPS.WAREHOUSE_VIEW_OWN)];

router.post('/generate-ppt', ...gate,
    pptController.handleGenerate({ variant: 'standard', label: 'standard' }));

router.post('/generate-ppt-v2', ...gate,
    pptController.handleGenerate({ variant: 'v2', label: 'v2' }));

// v3: the v2 deck with the fuller TCI specification table and a dedicated
// photographs slide. Same display flags as v2.
router.post('/generate-ppt-v3', ...gate,
    pptController.handleGenerate({ variant: 'v3', label: 'v3' }));

router.post('/generate-ppt-godamwale', ...gate,
    pptController.handleGenerate({ variant: 'godamwale', label: 'godamwale' }));

router.post('/generate-xlsx-last-mile', ...gate,
    pptController.handleGenerate({
        variant: 'last-mile', label: 'Last Mile', fileType: 'Excel',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }));

// TCI tolerates a missing/empty `ids`, falling back to placeholder warehouses so
// the layout can be previewed before real data is wired in. Kept from the engine.
router.post('/generate-ppt-tci', ...gate,
    pptController.handleGenerate({ variant: 'tci', label: 'TCI', allowEmptyIds: true }));

router.post('/generate-detailed-ppt', ...gate,
    pptController.handleGenerate({ variant: 'detailed', label: 'detailed' }));

module.exports = router;
