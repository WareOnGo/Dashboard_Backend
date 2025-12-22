// src/routes/warehouse-test.js - Test version of warehouse routes
const express = require('express');
const router = express.Router();
const BaseController = require('../controllers/baseController');

// Mock controller for testing
class MockWarehouseController extends BaseController {
    constructor() {
        super();
        this.mockWarehouseService = {
            getAllWarehouses: jest.fn(),
            getWarehouseById: jest.fn(),
            createWarehouse: jest.fn(),
            updateWarehouse: jest.fn(),
            deleteWarehouse: jest.fn(),
            searchWarehouses: jest.fn(),
            getWarehouseStatistics: jest.fn()
        };
        
        this.mockFileUploadService = {
            generatePresignedUrl: jest.fn(),
            generateMultiplePresignedUrls: jest.fn(),
            validateUploadedFile: jest.fn(),
            deleteUploadedFile: jest.fn(),
            getFileInfo: jest.fn()
        };
    }

    getAllWarehouses = this.asyncHandler(async (req, res, next) => {
        try {
            const options = {
                page: req.query.page ? parseInt(req.query.page) : undefined,
                limit: req.query.limit ? parseInt(req.query.limit) : undefined,
                city: req.query.city,
                state: req.query.state,
                zone: req.query.zone,
                warehouseType: req.query.warehouseType,
                sortBy: req.query.sortBy,
                sortOrder: req.query.sortOrder
            };

            Object.keys(options).forEach(key => {
                if (options[key] === undefined) {
                    delete options[key];
                }
            });

            const warehouses = await this.mockWarehouseService.getAllWarehouses(options);
            this.sendSuccess(res, warehouses);
        } catch (error) {
            next(error);
        }
    });

    getWarehouseById = this.asyncHandler(async (req, res, next) => {
        try {
            const id = this.extractId(req);
            const warehouse = await this.mockWarehouseService.getWarehouseById(id);
            this.sendSuccess(res, warehouse);
        } catch (error) {
            next(error);
        }
    });

    searchWarehouses = this.asyncHandler(async (req, res, next) => {
        try {
            const searchCriteria = {
                city: req.query.city,
                state: req.query.state,
                zone: req.query.zone,
                warehouseType: req.query.warehouseType,
                minSpace: req.query.minSpace,
                maxRate: req.query.maxRate
            };

            Object.keys(searchCriteria).forEach(key => {
                if (searchCriteria[key] === undefined) {
                    delete searchCriteria[key];
                }
            });

            const warehouses = await this.mockWarehouseService.searchWarehouses(searchCriteria);
            this.sendSuccess(res, warehouses);
        } catch (error) {
            next(error);
        }
    });

    getWarehouseStatistics = this.asyncHandler(async (req, res, next) => {
        try {
            const statistics = await this.mockWarehouseService.getWarehouseStatistics();
            this.sendSuccess(res, statistics);
        } catch (error) {
            next(error);
        }
    });
}

const mockController = new MockWarehouseController();

// Routes
router.get('/', mockController.getAllWarehouses);
router.get('/search', mockController.searchWarehouses);
router.get('/statistics', mockController.getWarehouseStatistics);
router.get('/:id', mockController.getWarehouseById);

// Export both router and controller for testing
module.exports = router;
module.exports.mockController = mockController;