// src/routes/warehouse.js
const express = require('express');
const router = express.Router();
const container = require('../container');
const validationMiddleware = require('../middleware/validation');
const { authMiddleware } = require('../middleware/authMiddleware');
const rateLimit = require('express-rate-limit');
const { verifyScoutToken } = require('../middleware/scoutMiddleware');

// Get controller instance from container
const warehouseController = container.resolve('warehouseController');

// --- Rate Limiters & Scout Middleware ---
const scoutRateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour window
    max: 15, // Limit each IP to 15 requests per window
    message: { error: "Too many scout requests from this IP, please try again after an hour" },
    standardHeaders: true,
    legacyHeaders: false,
});

// Higher cap for the presigned-URL endpoint: each media file = one request,
// so a single submission can easily need 30+ calls.
const scoutUploadRateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 200,
    message: { error: "Too many scout upload requests from this IP, please try again after an hour" },
    standardHeaders: true,
    legacyHeaders: false,
});

// --- CRUD Endpoints ---

/**
 * GET /api/warehouses
 */
router.get('/', 
    authMiddleware.authenticateJWT,
    warehouseController.getAllWarehouses
);

/**
 * GET /api/warehouses/search
 */
router.get('/search', 
    authMiddleware.authenticateJWT,
    warehouseController.searchWarehouses
);

/**
 * GET /api/warehouses/statistics
 */
router.get('/statistics', 
    authMiddleware.authenticateJWT,
    warehouseController.getWarehouseStatistics
);

/**
 * GET /api/warehouses/:id/contact-number
 */
router.get('/:id/contact-number',
    authMiddleware.authenticateJWT,
    warehouseController.getContactNumber
);

/**
 * GET /api/warehouses/:id
 */
router.get('/:id',
    authMiddleware.authenticateJWT,
    warehouseController.getWarehouseById
);

/**
 * POST /api/warehouses
 */
router.post('/', 
    authMiddleware.authenticateJWT,
    validationMiddleware.validateWarehouseCreate,
    warehouseController.createWarehouse
);

/**
 * POST /api/warehouses/scout
 * Unauthenticated endpoint for scout submissions
 */
router.post('/scout', 
    scoutRateLimiter,
    verifyScoutToken,
    validationMiddleware.validateWarehouseCreate,
    warehouseController.createScoutWarehouse
);

/**
 * PUT /api/warehouses/:id
 */
router.put('/:id', 
    authMiddleware.authenticateJWT,
    validationMiddleware.validateWarehouseUpdate,
    warehouseController.updateWarehouse
);

/**
 * DELETE /api/warehouses/:id
 */
router.delete('/:id', 
    authMiddleware.authenticateJWT,
    warehouseController.deleteWarehouse
);

// --- File Upload Endpoints ---

/**
 * POST /api/warehouses/presigned-url
 */
router.post('/presigned-url', 
    authMiddleware.authenticateJWT,
    validationMiddleware.validateFileUpload,
    warehouseController.generatePresignedUrl
);

/**
 * POST /api/warehouses/scout/presigned-url
 * Unauthenticated endpoint for scout file uploads
 */
router.post('/scout/presigned-url',
    scoutUploadRateLimiter,
    verifyScoutToken,
    validationMiddleware.validateFileUpload,
    warehouseController.generateScoutPresignedUrl
);

/**
 * POST /api/warehouses/presigned-urls/batch
 */
router.post('/presigned-urls/batch', 
    authMiddleware.authenticateJWT,
    validationMiddleware.validateBatchFileUpload,
    warehouseController.generateMultiplePresignedUrls
);

/**
 * POST /api/warehouses/files/:fileName/validate
 */
router.post('/files/:fileName/validate', 
    authMiddleware.authenticateJWT,
    warehouseController.validateUploadedFile
);

/**
 * DELETE /api/warehouses/files/:fileName
 */
router.delete('/files/:fileName', 
    authMiddleware.authenticateJWT,
    warehouseController.deleteUploadedFile
);

/**
 * GET /api/warehouses/files/:fileName
 */
router.get('/files/:fileName', 
    authMiddleware.authenticateJWT,
    warehouseController.getFileInfo
);

module.exports = router;
