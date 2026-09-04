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
 * Gated on DASHBOARD, matching GET /api/warehouses — if you can see the
 * warehouses, you can put them in a deck.
 *
 * These briefly required CAPS.DASHBOARD once before and broke every non-admin,
 * because the column was set on nobody (0 of 19 VerifiedNumber rows) and only
 * the admin master-override still worked. The precondition that failure implies
 * is now met: the column was backfilled for every active employee first, and a
 * user who lacks it cannot load the warehouse list either, so they never reach
 * an export button — rather than being refused at the end of a deck they had
 * already waited for. Do not reintroduce the gate on a column nobody holds.
 *
 * Paths are mounted flat under /api (not /api/ppt) to preserve the exact URLs
 * the frontend already calls, so cutover is a config change, not a code change.
 */
// Applied per-route rather than via router.use(): this router is mounted flat
// at /api, so router-level middleware would also run for every unmatched /api/*
// path and turn what should be a 404 into a 401.
const gate = [authMiddleware.authenticateJWT, authMiddleware.requireAccess(CAPS.DASHBOARD)];

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
