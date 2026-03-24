// src/controllers/warehouseController.js
const BaseController = require('./baseController');

/**
 * WarehouseController class for handling warehouse HTTP requests
 * Handles all warehouse-related endpoints and coordinates with services
 */
class WarehouseController extends BaseController {
    /**
     * Constructor for WarehouseController
     * @param {WarehouseService} warehouseService - Warehouse service instance
     * @param {FileUploadService} fileUploadService - File upload service instance
     */
    constructor(warehouseService, fileUploadService) {
        super();
        this.warehouseService = warehouseService;
        this.fileUploadService = fileUploadService;
    }

    /**
     * Get all warehouses
     * GET /api/warehouses
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     * @param {Function} next - Express next function
     */
    getAllWarehouses = this.asyncHandler(async (req, res, next) => {
        try {
            // Extract query parameters for filtering and pagination
            const options = {
                page: req.query.page ? parseInt(req.query.page) : undefined,
                limit: req.query.limit ? parseInt(req.query.limit) : undefined,
                city: req.query.city,
                state: req.query.state,
                zone: req.query.zone,
                warehouseType: req.query.warehouseType,
                sortBy: req.query.sortBy,
                sortOrder: req.query.sortOrder,
                // Add user context for potential filtering or audit
                requestedBy: req.user.id,
                requestedByEmail: req.user.email
            };

            // Remove undefined values
            Object.keys(options).forEach(key => {
                if (options[key] === undefined) {
                    delete options[key];
                }
            });

            // Get warehouses from service
            const warehouses = await this.warehouseService.getAllWarehouses(options);

            req.audit('READ', 'warehouse', null, 'Listed warehouses', {
                filters: { city: options.city, state: options.state, zone: options.zone, warehouseType: options.warehouseType },
                page: options.page,
                limit: options.limit,
                resultCount: warehouses.data?.length ?? warehouses.length
            });

            // Send successful response
            this.sendSuccess(res, warehouses);
        } catch (error) {
            next(error);
        }
    });

    /**
     * Get warehouse by ID
     * GET /api/warehouses/:id
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     * @param {Function} next - Express next function
     */
    getWarehouseById = this.asyncHandler(async (req, res, next) => {
        try {
            // Extract and validate ID
            const id = this.extractId(req);
            
            // Get warehouse from service
            const warehouse = await this.warehouseService.getWarehouseById(id);

            req.audit('READ', 'warehouse', id, `Viewed warehouse ${id}`);

            // Send successful response
            this.sendSuccess(res, warehouse);
        } catch (error) {
            next(error);
        }
    });

    /**
     * Create a new warehouse
     * POST /api/warehouses
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     * @param {Function} next - Express next function
     */
    createWarehouse = this.asyncHandler(async (req, res, next) => {
        try {
            // Add authenticated user context to warehouse data
            const warehouseData = {
                ...req.body,
                uploadedBy: req.user.email, // Use authenticated user's email
                createdBy: req.user.id,     // Track who created the record
                createdByEmail: req.user.email
            };

            // Create warehouse through service
            const newWarehouse = await this.warehouseService.createWarehouse(warehouseData);

            req.audit('CREATE', 'warehouse', newWarehouse.id, `Created warehouse in ${req.body.city}, ${req.body.state}`, {
                warehouseType: req.body.warehouseType,
                city: req.body.city,
                state: req.body.state,
                zone: req.body.zone
            });

            // Send created response
            this.sendCreated(res, newWarehouse);
        } catch (error) {
            next(error);
        }
    });

    /**
     * Update an existing warehouse
     * PUT /api/warehouses/:id
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     * @param {Function} next - Express next function
     */
    updateWarehouse = this.asyncHandler(async (req, res, next) => {
        try {
            // Extract and validate ID
            const id = this.extractId(req);
            
            // Validate that request body is not empty
            if (!req.body || Object.keys(req.body).length === 0) {
                return this.sendError(res, 'Request body cannot be empty for an update', 400);
            }
            
            // Add authenticated user context to update data
            const updateData = {
                ...req.body,
                updatedBy: req.user.id,     // Track who updated the record
                updatedByEmail: req.user.email,
                lastModified: new Date()
            };
            
            // Update warehouse through service
            const updatedWarehouse = await this.warehouseService.updateWarehouse(id, updateData);

            req.audit('UPDATE', 'warehouse', id, `Updated warehouse ${id}`, {
                updatedFields: Object.keys(req.body)
            });

            // Send successful response
            this.sendSuccess(res, updatedWarehouse);
        } catch (error) {
            next(error);
        }
    });

    /**
     * Delete a warehouse
     * DELETE /api/warehouses/:id
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     * @param {Function} next - Express next function
     */
    deleteWarehouse = this.asyncHandler(async (req, res, next) => {
        try {
            // Extract and validate ID
            const id = this.extractId(req);
            
            // Add user context for audit logging
            const deleteContext = {
                deletedBy: req.user.id,
                deletedByEmail: req.user.email,
                deletedAt: new Date()
            };
            
            // Delete warehouse through service
            await this.warehouseService.deleteWarehouse(id, deleteContext);

            req.audit('DELETE', 'warehouse', id, `Deleted warehouse ${id}`);

            // Send no content response
            this.sendNoContent(res);
        } catch (error) {
            next(error);
        }
    });

    /**
     * Get contact number for a specific warehouse
     * GET /api/warehouses/:id/contact-number
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     * @param {Function} next - Express next function
     */
    getContactNumber = this.asyncHandler(async (req, res, next) => {
        try {
            const id = this.extractId(req);
            const contactInfo = await this.warehouseService.getContactNumber(id);

            req.audit('READ', 'contact', id.toString(), `Revealed contact number for warehouse ${id}`, {
                warehouseId: id
            });

            this.sendSuccess(res, contactInfo);
        } catch (error) {
            next(error);
        }
    });

    /**
     * Search warehouses
     * GET /api/warehouses/search
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     * @param {Function} next - Express next function
     */
    searchWarehouses = this.asyncHandler(async (req, res, next) => {
        try {
            // Extract search criteria from query parameters
            const searchCriteria = {
                city: req.query.city,
                state: req.query.state,
                zone: req.query.zone,
                warehouseType: req.query.warehouseType,
                minSpace: req.query.minSpace,
                maxRate: req.query.maxRate
            };

            // Remove undefined values
            Object.keys(searchCriteria).forEach(key => {
                if (searchCriteria[key] === undefined) {
                    delete searchCriteria[key];
                }
            });

            // Search warehouses through service
            const warehouses = await this.warehouseService.searchWarehouses(searchCriteria);

            req.audit('SEARCH', 'warehouse', null, 'Searched warehouses', {
                criteria: searchCriteria,
                resultCount: warehouses.length
            });

            // Send successful response
            this.sendSuccess(res, warehouses);
        } catch (error) {
            next(error);
        }
    });

    /**
     * Get warehouse statistics
     * GET /api/warehouses/statistics
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     * @param {Function} next - Express next function
     */
    getWarehouseStatistics = this.asyncHandler(async (req, res, next) => {
        try {
            // Get statistics from service
            const statistics = await this.warehouseService.getWarehouseStatistics();

            req.audit('READ', 'warehouse', null, 'Viewed warehouse statistics');

            // Send successful response
            this.sendSuccess(res, statistics);
        } catch (error) {
            next(error);
        }
    });

    /**
     * Generate presigned URL for file upload
     * POST /api/warehouses/presigned-url
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     * @param {Function} next - Express next function
     */
    generatePresignedUrl = this.asyncHandler(async (req, res, next) => {
        try {
            // Extract upload request data
            const uploadRequest = {
                contentType: req.body.contentType
            };

            // Extract additional options with authenticated user context
            const options = {
                expiresIn: req.body.expiresIn || 360,
                keyPrefix: req.body.keyPrefix || '',
                uploadedBy: req.user.email,  // Use authenticated user's email
                uploadedById: req.user.id,   // Track user ID
                purpose: 'warehouse-image'
            };

            // Generate presigned URL through service
            const uploadData = await this.fileUploadService.generatePresignedUrl(uploadRequest, options);

            req.audit('CREATE', 'file', uploadData.fileName || null, 'Generated presigned upload URL', {
                contentType: req.body.contentType,
                keyPrefix: req.body.keyPrefix
            });

            // Send successful response
            this.sendSuccess(res, uploadData);
        } catch (error) {
            next(error);
        }
    });

    /**
     * Generate multiple presigned URLs for batch upload
     * POST /api/warehouses/presigned-urls/batch
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     * @param {Function} next - Express next function
     */
    generateMultiplePresignedUrls = this.asyncHandler(async (req, res, next) => {
        try {
            // Extract upload requests array
            const uploadRequests = req.body.uploadRequests;
            
            if (!Array.isArray(uploadRequests)) {
                return this.sendError(res, 'uploadRequests must be an array', 400);
            }

            // Extract additional options with authenticated user context
            const options = {
                expiresIn: req.body.expiresIn || 360,
                keyPrefix: req.body.keyPrefix || 'batch',
                uploadedBy: req.user.email,  // Use authenticated user's email
                uploadedById: req.user.id,   // Track user ID
                maxBatchSize: 10
            };

            // Generate multiple presigned URLs through service
            const batchUploadData = await this.fileUploadService.generateMultiplePresignedUrls(uploadRequests, options);

            req.audit('CREATE', 'file', null, `Generated ${uploadRequests.length} presigned upload URLs (batch)`, {
                fileCount: uploadRequests.length,
                keyPrefix: req.body.keyPrefix
            });

            // Send successful response
            this.sendSuccess(res, batchUploadData);
        } catch (error) {
            next(error);
        }
    });

    /**
     * Validate uploaded file
     * POST /api/warehouses/files/:fileName/validate
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     * @param {Function} next - Express next function
     */
    validateUploadedFile = this.asyncHandler(async (req, res, next) => {
        try {
            const fileName = req.params.fileName;
            
            if (!fileName) {
                return this.sendError(res, 'fileName parameter is required', 400);
            }

            // Extract validation options
            const validationOptions = {
                checkSize: req.body.checkSize !== false,
                checkType: req.body.checkType !== false,
                maxSize: req.body.maxSize
            };

            // Validate file through service
            const validationResult = await this.fileUploadService.validateUploadedFile(fileName, validationOptions);

            req.audit('READ', 'file', fileName, `Validated uploaded file ${fileName}`);

            // Send successful response
            this.sendSuccess(res, validationResult);
        } catch (error) {
            next(error);
        }
    });

    /**
     * Delete uploaded file
     * DELETE /api/warehouses/files/:fileName
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     * @param {Function} next - Express next function
     */
    deleteUploadedFile = this.asyncHandler(async (req, res, next) => {
        try {
            const fileName = req.params.fileName;
            
            if (!fileName) {
                return this.sendError(res, 'fileName parameter is required', 400);
            }

            // Delete file through service
            await this.fileUploadService.deleteUploadedFile(fileName);

            req.audit('DELETE', 'file', fileName, `Deleted file ${fileName}`);

            // Send no content response
            this.sendNoContent(res);
        } catch (error) {
            next(error);
        }
    });

    /**
     * Get file information
     * GET /api/warehouses/files/:fileName
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     * @param {Function} next - Express next function
     */
    getFileInfo = this.asyncHandler(async (req, res, next) => {
        try {
            const fileName = req.params.fileName;
            
            if (!fileName) {
                return this.sendError(res, 'fileName parameter is required', 400);
            }

            // Get file info through service
            const fileInfo = await this.fileUploadService.getFileInfo(fileName);

            req.audit('READ', 'file', fileName, `Viewed file info for ${fileName}`);

            // Send successful response
            this.sendSuccess(res, fileInfo);
        } catch (error) {
            next(error);
        }
    });
}

module.exports = WarehouseController;