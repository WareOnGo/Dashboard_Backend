// src/routes/warehouse.js
const express = require('express');
const router = express.Router();
const container = require('../container');
const validationMiddleware = require('../middleware/validation');
// TODO: Uncomment when ready to enable authentication
// const { authMiddleware } = require('../middleware/authMiddleware');

// Get controller instance from container
const warehouseController = container.resolve('warehouseController');

// --- CRUD Endpoints ---

/**
 * GET /api/warehouses
 */
router.get('/', 
    // authMiddleware.authenticateJWT, // TODO: Uncomment to enable auth
    warehouseController.getAllWarehouses
);

/**
 * GET /api/warehouses/search
 */
router.get('/search', 
    // authMiddleware.authenticateJWT, // TODO: Uncomment to enable auth
    warehouseController.searchWarehouses
);

/**
 * GET /api/warehouses/statistics
 */
router.get('/statistics', 
    // authMiddleware.authenticateJWT, // TODO: Uncomment to enable auth
    warehouseController.getWarehouseStatistics
);

/**
 * GET /api/warehouses/:id
 */
router.get('/:id', 
    // authMiddleware.authenticateJWT, // TODO: Uncomment to enable auth
    warehouseController.getWarehouseById
);

/**
 * POST /api/warehouses
 */
router.post('/', 
    // authMiddleware.authenticateJWT, // TODO: Uncomment to enable auth
    validationMiddleware.validateWarehouseCreate,
    warehouseController.createWarehouse
);

/**
 * PUT /api/warehouses/:id
 */
router.put('/:id', 
    // authMiddleware.authenticateJWT, // TODO: Uncomment to enable auth
    validationMiddleware.validateWarehouseUpdate,
    warehouseController.updateWarehouse
);

/**
 * DELETE /api/warehouses/:id
 */
router.delete('/:id', 
    // authMiddleware.authenticateJWT, // TODO: Uncomment to enable auth
    warehouseController.deleteWarehouse
);

// --- File Upload Endpoints ---

/**
 * POST /api/warehouses/presigned-url
 */
router.post('/presigned-url', 
    // authMiddleware.authenticateJWT, // TODO: Uncomment to enable auth
    validationMiddleware.validateFileUpload,
    warehouseController.generatePresignedUrl
);

/**
 * POST /api/warehouses/presigned-urls/batch
 */
router.post('/presigned-urls/batch', 
    // authMiddleware.authenticateJWT, // TODO: Uncomment to enable auth
    validationMiddleware.validateBatchFileUpload,
    warehouseController.generateMultiplePresignedUrls
);

/**
 * POST /api/warehouses/files/:fileName/validate
 */
router.post('/files/:fileName/validate', 
    // authMiddleware.authenticateJWT, // TODO: Uncomment to enable auth
    warehouseController.validateUploadedFile
);

/**
 * DELETE /api/warehouses/files/:fileName
 */
router.delete('/files/:fileName', 
    // authMiddleware.authenticateJWT, // TODO: Uncomment to enable auth
    warehouseController.deleteUploadedFile
);

/**
 * GET /api/warehouses/files/:fileName
 */
router.get('/files/:fileName', 
    // authMiddleware.authenticateJWT, // TODO: Uncomment to enable auth
    warehouseController.getFileInfo
);

module.exports = router;
