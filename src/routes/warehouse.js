// src/routes/warehouse.js
const express = require('express');
const router = express.Router();
const container = require('../container');
const validationMiddleware = require('../middleware/validation');

// Get controller instance from container
const warehouseController = container.resolve('warehouseController');

// --- CRUD Endpoints ---

/**
 * GET /api/warehouses
 */
router.get('/', warehouseController.getAllWarehouses);

/**
 * GET /api/warehouses/search
 */
router.get('/search', warehouseController.searchWarehouses);

/**
 * GET /api/warehouses/statistics
 */
router.get('/statistics', warehouseController.getWarehouseStatistics);

/**
 * GET /api/warehouses/:id
 */
router.get('/:id', warehouseController.getWarehouseById);

/**
 * POST /api/warehouses
 */
router.post('/', 
    validationMiddleware.validateWarehouseCreate,
    warehouseController.createWarehouse
);

/**
 * PUT /api/warehouses/:id
 */
router.put('/:id', 
    validationMiddleware.validateWarehouseUpdate,
    warehouseController.updateWarehouse
);

/**
 * DELETE /api/warehouses/:id
 */
router.delete('/:id', warehouseController.deleteWarehouse);

// --- File Upload Endpoints ---

/**
 * POST /api/warehouses/presigned-url
 */
router.post('/presigned-url', 
    validationMiddleware.validateFileUpload,
    warehouseController.generatePresignedUrl
);

/**
 * POST /api/warehouses/presigned-urls/batch
 */
router.post('/presigned-urls/batch', 
    validationMiddleware.validateBatchFileUpload,
    warehouseController.generateMultiplePresignedUrls
);

/**
 * POST /api/warehouses/files/:fileName/validate
 */
router.post('/files/:fileName/validate', warehouseController.validateUploadedFile);

/**
 * DELETE /api/warehouses/files/:fileName
 */
router.delete('/files/:fileName', warehouseController.deleteUploadedFile);

/**
 * GET /api/warehouses/files/:fileName
 */
router.get('/files/:fileName', warehouseController.getFileInfo);

module.exports = router;