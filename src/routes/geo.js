// src/routes/geo.js
const express = require('express');
const router = express.Router();
const container = require('../container');
const { authMiddleware } = require('../middleware/authMiddleware');

const geoController = container.resolve('geoController');

/**
 * Map view routes.
 *
 * Gated by JWT only, matching GET /api/warehouses — anyone who can see the
 * warehouse list can see it on a map. Creating and editing our own points is a
 * normal dashboard action, not a reviewer-only one, so it sits behind the same
 * gate rather than requiring the REVIEW capability (unlike micro-market polygons,
 * which drive automated tagging and therefore need review).
 */
router.use(authMiddleware.authenticateJWT);

/** Categories + counts, for building layer toggles. */
router.get('/layers', geoController.layers);

// --- Viewport reads (bbox-bounded, return GeoJSON FeatureCollections) ---
router.get('/osm-pois', geoController.osmPois);
router.get('/points', geoController.ownPois);
router.get('/warehouses', geoController.warehouses);

// --- Our own points of interest ---
router.post('/points', geoController.createPoint);
router.put('/points/:id', geoController.updatePoint);
router.delete('/points/:id', geoController.deletePoint);

module.exports = router;
