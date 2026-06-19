// src/routes/microMarkets.js
const express = require('express');
const router = express.Router();
const container = require('../container');
const { authMiddleware } = require('../middleware/authMiddleware');
const { CAPS } = require('../utils/access');

const microMarketController = container.resolve('microMarketController');

// Authenticate, then require the REVIEW capability. Reviewers and admins both pass.
// Unlike staging, DELETE is NOT admin-only here: drawing and erasing areas is the
// core reviewer workflow, so reviewers need delete on their own polygons.
router.use(authMiddleware.authenticateJWT, authMiddleware.requireAccess(CAPS.REVIEW));

/** GET /api/micro-markets — all areas as a GeoJSON FeatureCollection */
router.get('/', microMarketController.list);

/** POST /api/micro-markets — create an area */
router.post('/', microMarketController.create);

/** PUT /api/micro-markets/:id — update geometry and/or name/city */
router.put('/:id', microMarketController.update);

/** DELETE /api/micro-markets/:id — remove an area (idempotent) */
router.delete('/:id', microMarketController.remove);

module.exports = router;
