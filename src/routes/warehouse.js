// src/routes/warehouse.js
const express = require('express');
const router = express.Router();
const container = require('../container');
const validationMiddleware = require('../middleware/validation');
const { authMiddleware } = require('../middleware/authMiddleware');

// Get controller instance from container
const warehouseController = container.resolve('warehouseController');

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
