// src/services/warehouseService.js
const BaseService = require('./baseService');
const WarehouseValidator = require('../validators/warehouseValidator');

/**
 * WarehouseService class for handling warehouse business logic
 * Contains all business operations for warehouse management
 */
class WarehouseService extends BaseService {
    constructor(warehouseModel) {
        super();
        this.warehouseModel = warehouseModel;
    }

    /**
     * Get all warehouses with optional filtering and pagination
     * @param {Object} options - Query options
     * @param {number} options.page - Page number for pagination
     * @param {number} options.limit - Number of items per page
     * @param {string} options.city - Filter by city
     * @param {string} options.state - Filter by state
     * @param {string} options.zone - Filter by zone
     * @param {string} options.warehouseType - Filter by warehouse type
     * @param {string} options.sortBy - Field to sort by
     * @param {string} options.sortOrder - Sort order (asc/desc)
     * @returns {Array} Array of warehouses
     */
    async getAllWarehouses(options = {}) {
        return this.executeOperation(async () => {
            // Validate query parameters if provided
            if (Object.keys(options).length > 0) {
                this.validateData(options, (data) => WarehouseValidator.validateQuery(data));
            }

            // Apply business rules for filtering
            const queryOptions = this.buildQueryOptions(options);
            
            // Fetch warehouses from model
            const warehouses = await this.warehouseModel.findAll(queryOptions);
            
            // Apply business transformations
            return this.transformWarehouseList(warehouses);
        });
    }

    /**
     * Get a warehouse by ID
     * @param {number} id - Warehouse ID
     * @returns {Object|null} Warehouse data or null if not found
     */
    async getWarehouseById(id) {
        return this.executeOperation(async () => {
            // Validate ID parameter
            this.validateData({ id: id.toString() }, (data) => WarehouseValidator.validateId(data));
            
            // Fetch warehouse from model
            const warehouse = await this.warehouseModel.findById(id);
            
            if (!warehouse) {
                const error = new Error(`Warehouse with ID ${id} not found`);
                error.name = 'NotFoundError';
                error.statusCode = 404;
                throw error;
            }
            
            // Apply business transformations
            return this.transformWarehouse(warehouse);
        });
    }

    /**
     * Create a new warehouse
     * @param {Object} warehouseData - Warehouse data to create
     * @returns {Object} Created warehouse
     */
    async createWarehouse(warehouseData) {
        return this.executeOperation(async () => {
            // Validate input data
            const validatedData = this.validateData(warehouseData, (data) => WarehouseValidator.validateCreate(data));
            
            // Apply business rules and transformations
            const processedData = this.applyCreateBusinessRules(validatedData);
            
            // Create warehouse through model
            const newWarehouse = await this.warehouseModel.create(processedData);
            
            // Apply post-creation business logic
            return this.transformWarehouse(newWarehouse);
        });
    }

    /**
     * Update an existing warehouse
     * @param {number} id - Warehouse ID
     * @param {Object} updateData - Data to update
     * @returns {Object} Updated warehouse
     */
    async updateWarehouse(id, updateData) {
        return this.executeOperation(async () => {
            // Validate ID parameter
            this.validateData({ id: id.toString() }, (data) => WarehouseValidator.validateId(data));
            
            // Validate update data
            const validatedData = this.validateData(updateData, (data) => WarehouseValidator.validateUpdate(data));
            
            // Check if warehouse exists
            const exists = await this.warehouseModel.exists(id);
            if (!exists) {
                const error = new Error(`Warehouse with ID ${id} not found`);
                error.name = 'NotFoundError';
                error.statusCode = 404;
                throw error;
            }
            
            // Apply business rules for updates
            const processedData = this.applyUpdateBusinessRules(validatedData);
            
            // Update warehouse through model
            const updatedWarehouse = await this.warehouseModel.update(id, processedData);
            
            // Apply post-update business logic
            return this.transformWarehouse(updatedWarehouse);
        });
    }

    /**
     * Delete a warehouse
     * @param {number} id - Warehouse ID
     * @returns {boolean} True if deleted successfully
     */
    async deleteWarehouse(id) {
        return this.executeOperation(async () => {
            // Validate ID parameter
            this.validateData({ id: id.toString() }, (data) => WarehouseValidator.validateId(data));
            
            // Check if warehouse exists
            const exists = await this.warehouseModel.exists(id);
            if (!exists) {
                const error = new Error(`Warehouse with ID ${id} not found`);
                error.name = 'NotFoundError';
                error.statusCode = 404;
                throw error;
            }
            
            // Apply business rules for deletion
            await this.applyDeleteBusinessRules(id);
            
            // Delete warehouse through model
            await this.warehouseModel.delete(id);
            
            return true;
        });
    }

    /**
     * Search warehouses by criteria
     * @param {Object} searchCriteria - Search parameters
     * @returns {Array} Array of matching warehouses
     */
    async searchWarehouses(searchCriteria) {
        return this.executeOperation(async () => {
            // Validate search criteria
            const validatedCriteria = this.validateSearchCriteria(searchCriteria);
            
            // Apply business rules for search
            const processedCriteria = this.applySearchBusinessRules(validatedCriteria);
            
            // Search warehouses through model
            const warehouses = await this.warehouseModel.search(processedCriteria);
            
            // Apply business transformations
            return this.transformWarehouseList(warehouses);
        });
    }

    /**
     * Get warehouse statistics
     * @returns {Object} Warehouse statistics
     */
    async getWarehouseStatistics() {
        return this.executeOperation(async () => {
            // Get statistics from model
            const stats = await this.warehouseModel.getStatistics();
            
            // Apply business transformations to statistics
            return this.transformStatistics(stats);
        });
    }

    /**
     * Build query options from request parameters
     * @param {Object} options - Request options
     * @returns {Object} Processed query options
     * @private
     */
    buildQueryOptions(options) {
        const queryOptions = {};
        
        // Handle pagination
        if (options.page && options.limit) {
            queryOptions.skip = (options.page - 1) * options.limit;
            queryOptions.take = options.limit;
        }
        
        // Handle sorting
        if (options.sortBy) {
            queryOptions.orderBy = {
                [options.sortBy]: options.sortOrder || 'desc'
            };
        }
        
        // Handle filtering - build where clause
        const where = {};
        if (options.city) {
            where.city = {
                contains: options.city,
                mode: 'insensitive'
            };
        }
        
        if (options.state) {
            where.state = {
                contains: options.state,
                mode: 'insensitive'
            };
        }
        
        if (options.zone) {
            where.zone = {
                contains: options.zone,
                mode: 'insensitive'
            };
        }
        
        if (options.warehouseType) {
            where.warehouseType = {
                contains: options.warehouseType,
                mode: 'insensitive'
            };
        }
        
        if (Object.keys(where).length > 0) {
            queryOptions.where = where;
        }
        
        return queryOptions;
    }

    /**
     * Apply business rules for warehouse creation
     * @param {Object} data - Validated warehouse data
     * @returns {Object} Processed data
     * @private
     */
    applyCreateBusinessRules(data) {
        // Apply business transformations
        const processedData = { ...data };
        
        // Ensure required nested data structure
        if (!processedData.warehouseData) {
            processedData.warehouseData = {};
        }
        
        // Apply default values or business logic
        if (!processedData.availability) {
            processedData.availability = 'Available';
        }
        
        // Normalize contact number format
        if (processedData.contactNumber) {
            processedData.contactNumber = this.normalizeContactNumber(processedData.contactNumber);
        }
        
        // Validate space requirements
        if (processedData.totalSpaceSqft && Array.isArray(processedData.totalSpaceSqft)) {
            processedData.totalSpaceSqft = processedData.totalSpaceSqft.filter(space => space > 0);
        }
        
        return processedData;
    }

    /**
     * Apply business rules for warehouse updates
     * @param {Object} data - Validated update data
     * @returns {Object} Processed data
     * @private
     */
    applyUpdateBusinessRules(data) {
        const processedData = { ...data };
        
        // Normalize contact number if provided
        if (processedData.contactNumber) {
            processedData.contactNumber = this.normalizeContactNumber(processedData.contactNumber);
        }
        
        // Validate space requirements if provided
        if (processedData.totalSpaceSqft && Array.isArray(processedData.totalSpaceSqft)) {
            processedData.totalSpaceSqft = processedData.totalSpaceSqft.filter(space => space > 0);
        }
        
        return processedData;
    }

    /**
     * Apply business rules for warehouse deletion
     * @param {number} id - Warehouse ID
     * @private
     */
    async applyDeleteBusinessRules(id) {
        // Add any business logic for deletion
        // For example: check if warehouse has active bookings, etc.
        // This is a placeholder for future business rules
    }

    /**
     * Validate search criteria
     * @param {Object} criteria - Search criteria
     * @returns {Object} Validated criteria
     * @private
     */
    validateSearchCriteria(criteria) {
        // Basic validation for search criteria
        const validatedCriteria = {};
        
        if (criteria.city && typeof criteria.city === 'string') {
            validatedCriteria.city = criteria.city.trim();
        }
        
        if (criteria.state && typeof criteria.state === 'string') {
            validatedCriteria.state = criteria.state.trim();
        }
        
        if (criteria.zone && typeof criteria.zone === 'string') {
            validatedCriteria.zone = criteria.zone.trim();
        }
        
        if (criteria.warehouseType && typeof criteria.warehouseType === 'string') {
            validatedCriteria.warehouseType = criteria.warehouseType.trim();
        }
        
        if (criteria.minSpace && !isNaN(criteria.minSpace)) {
            validatedCriteria.minSpace = [parseInt(criteria.minSpace)];
        }
        
        if (criteria.maxRate && typeof criteria.maxRate === 'string') {
            validatedCriteria.maxRate = criteria.maxRate;
        }
        
        return validatedCriteria;
    }

    /**
     * Apply business rules for search
     * @param {Object} criteria - Validated search criteria
     * @returns {Object} Processed criteria
     * @private
     */
    applySearchBusinessRules(criteria) {
        // Apply any business logic for search
        return criteria;
    }

    /**
     * Transform warehouse data for response
     * @param {Object} warehouse - Raw warehouse data
     * @returns {Object} Transformed warehouse data
     * @private
     */
    transformWarehouse(warehouse) {
        if (!warehouse) return null;
        
        // Apply any business transformations
        const transformed = { ...warehouse };
        
        // Ensure consistent data structure
        if (!transformed.WarehouseData) {
            transformed.WarehouseData = {};
        }
        
        return transformed;
    }

    /**
     * Transform warehouse list for response
     * @param {Array} warehouses - Array of raw warehouse data
     * @returns {Array} Array of transformed warehouse data
     * @private
     */
    transformWarehouseList(warehouses) {
        return warehouses.map(warehouse => this.transformWarehouse(warehouse));
    }

    /**
     * Transform statistics for response
     * @param {Object} stats - Raw statistics
     * @returns {Object} Transformed statistics
     * @private
     */
    transformStatistics(stats) {
        return {
            ...stats,
            // Add any business logic for statistics transformation
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Normalize contact number format
     * @param {string} contactNumber - Raw contact number
     * @returns {string} Normalized contact number
     * @private
     */
    normalizeContactNumber(contactNumber) {
        // Remove all non-digit characters
        const digits = contactNumber.replace(/\D/g, '');
        
        // Apply basic formatting (this is a simple example)
        if (digits.length === 10) {
            return `+91${digits}`;
        } else if (digits.length === 12 && digits.startsWith('91')) {
            return `+${digits}`;
        }
        
        return contactNumber; // Return original if can't normalize
    }
}

module.exports = WarehouseService;