// src/routes/ppt.js
const express = require('express');
const router = express.Router();
const container = require('../container');
const { authMiddleware } = require('../middleware/authMiddleware');
const { CAPS } = require('../utils/access');

const pptController = container.resolve('pptController');

/**
 * Warehouse proposal deck generation.
 *
 * Merged in from the standalone Warehouse Proposal Engine, which ran these
 * endpoints with no authentication of any kind — the browser sent a Bearer
 * token and the service ignored it, so anyone who could reach its public URL
 * could generate a deck for any warehouse ID. They now sit behind the same gate
 * as the rest of the dashboard.
 *
 * DASHBOARD rather than REVIEW: exporting a proposal is normal dashboard work,
 * not a reviewer action. The frontend already sends the JWT on these calls, so
 * the gate is transparent to it.
 *
 * Paths are mounted flat under /api (not /api/ppt) to preserve the exact URLs
 * the frontend already calls, so cutover is a config change, not a code change.
 */
// Applied per-route rather than via router.use(): this router is mounted flat
// at /api, so router-level middleware would also run for every unmatched /api/*
// path and turn what should be a 404 into a 401.
const gate = [
    authMiddleware.authenticateJWT,
    authMiddleware.requireAccess(CAPS.DASHBOARD),
];

router.post('/generate-ppt', ...gate,
    pptController.handleGenerate({ variant: 'standard', label: 'standard' }));

router.post('/generate-ppt-v2', ...gate,
    pptController.handleGenerate({ variant: 'v2', label: 'v2' }));

router.post('/generate-ppt-godamwale', ...gate,
    pptController.handleGenerate({ variant: 'godamwale', label: 'godamwale' }));

// TCI tolerates a missing/empty `ids`, falling back to placeholder warehouses so
// the layout can be previewed before real data is wired in. Kept from the engine.
router.post('/generate-ppt-tci', ...gate,
    pptController.handleGenerate({ variant: 'tci', label: 'TCI', allowEmptyIds: true }));

router.post('/generate-detailed-ppt', ...gate,
    pptController.handleGenerate({ variant: 'detailed', label: 'detailed' }));

module.exports = router;
