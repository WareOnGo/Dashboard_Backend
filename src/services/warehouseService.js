// src/services/warehouseService.js
const BaseService = require('./baseService');
const WarehouseValidator = require('../validators/warehouseValidator');

/** Server-side pagination defaults for the warehouse list. */
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

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
            // Validate + coerce query params (page/limit → numbers, unknown keys stripped).
            const filters = (options && Object.keys(options).length > 0)
                ? this.validateData(options, (data) => WarehouseValidator.validateQuery(data))
                : {};

            const fetchAll = filters.all === 'true';
            const page = filters.page && filters.page > 0 ? filters.page : 1;
            const limit = filters.limit && filters.limit > 0
                ? Math.min(filters.limit, MAX_PAGE_SIZE)
                : DEFAULT_PAGE_SIZE;

            const where = await this.resolveWhere(filters);
            const orderBy = filters.sortBy
                ? { [filters.sortBy]: filters.sortOrder || 'desc' }
                : { createdAt: 'desc' };

            // Page rows + total count fetched together; count uses the same where clause
            // so the pager total always matches the filtered set. With all=true we skip
            // paging and return the whole filtered set (full-data consumers).
            const findArgs = { where, orderBy };
            if (!fetchAll) {
                findArgs.skip = (page - 1) * limit;
                findArgs.take = limit;
            }
            const [rows, total] = await Promise.all([
                this.warehouseModel.findAll(findArgs),
                this.warehouseModel.count(where),
            ]);

            return {
                data: this.transformWarehouseList(rows),
                pagination: fetchAll
                    ? { page: 1, limit: total, total, totalPages: 1 }
                    : { page, limit, total, totalPages: Math.ceil(total / limit) },
            };
        });
    }

    /**
     * Get coordinates ({ id, lat, lng }) for ALL warehouses matching the given
     * filters — no pagination. Lets the map plot the full filtered set while the
     * list view pages. Uses the same filter resolution as the list, so the map and
     * the list always agree. Rows without coordinates are dropped (can't be plotted).
     * @param {Object} options - Same query params as getAllWarehouses (paging/sort ignored)
     * @returns {Array<{id:number, lat:number, lng:number}>}
     */
    async getWarehouseCoordinates(options = {}) {
        return this.executeOperation(async () => {
            const filters = (options && Object.keys(options).length > 0)
                ? this.validateData(options, (data) => WarehouseValidator.validateQuery(data))
                : {};

            const where = await this.resolveWhere(filters);
            const rows = await this.warehouseModel.findCoordinates(where);

            return rows
                .map((w) => ({
                    id: w.id,
                    lat: w.WarehouseData?.latitude ?? null,
                    lng: w.WarehouseData?.longitude ?? null,
                }))
                .filter((p) => p.lat != null && p.lng != null);
        });
    }

    /**
     * Resolve validated query filters into a Prisma `where`, including the numeric
     * ranges that need a raw id pre-query (area on Int[] totalSpaceSqft, budget on
     * String ratePerSqft). Shared by the list and coordinates endpoints so they
     * filter identically.
     * @param {Object} filters - Validated query params
     * @returns {Promise<Object>} Prisma where clause
     * @private
     */
    async resolveWhere(filters) {
        const where = this.buildWhere(filters);

        const ranges = {
            areaMin: filters.minArea,
            areaMax: filters.maxArea,
            budgetMin: filters.minRate,
            budgetMax: filters.maxRate,
        };
        if (Object.values(ranges).some((v) => v != null)) {
            const ids = await this.warehouseModel.findIdsByNumericRange(ranges);
            where.id = { in: ids || [] };
        }

        return where;
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
     * Get contact number for a specific warehouse (bypasses redaction)
     * @param {number} warehouseId - Warehouse ID
     * @returns {Object} Contact info { contactNumber, contactPerson }
     */
    async getContactNumber(warehouseId) {
        return this.executeOperation(async () => {
            this.validateData({ id: warehouseId.toString() }, (data) => WarehouseValidator.validateId(data));

            const warehouse = await this.warehouseModel.findById(warehouseId);
            if (!warehouse) {
                const error = new Error(`Warehouse with ID ${warehouseId} not found`);
                error.name = 'NotFoundError';
                error.statusCode = 404;
                throw error;
            }

            return { contactNumber: warehouse.contactNumber, contactPerson: warehouse.contactPerson };
        });
    }

    /**
     * Build query options from request parameters
     * @param {Object} options - Request options
     * @returns {Object} Processed query options
     * @private
     */
    /**
     * Build a Prisma `where` clause from validated query filters.
     *
     * Step 1 covers the "easy" filters (top-level string/boolean columns + free-text
     * search). The harder ones — budget range (ratePerSqft is a String), area range
     * (totalSpaceSqft is Int[]), and nested WarehouseData filters (fireNoc/landType) —
     * are handled in a later step.
     *
     * @param {Object} filters - Validated query params
     * @returns {Object} Prisma where clause ({} = match all)
     * @private
     */
    buildWhere(filters) {
        const where = {};
        // Relation filters and multi-clause conditions go in an AND array so they
        // compose cleanly with the top-level keys and the search OR.
        const and = [];

        // Free-text search across the common string columns. A purely numeric term
        // also matches the warehouse id exactly (substring-on-id is a separate step).
        if (filters.search && filters.search.trim()) {
            const term = filters.search.trim();
            const or = [
                { address: { contains: term, mode: 'insensitive' } },
                { city: { contains: term, mode: 'insensitive' } },
                { contactPerson: { contains: term, mode: 'insensitive' } },
                { warehouseType: { contains: term, mode: 'insensitive' } },
                { warehouseOwnerType: { contains: term, mode: 'insensitive' } },
            ];
            if (/^\d+$/.test(term)) or.push({ id: Number(term) });
            where.OR = or;
        }

        // Simple case-insensitive "contains" filters on top-level string columns.
        const containsFields = [
            'city', 'state', 'zone', 'warehouseType',
            'warehouseOwnerType', 'availability', 'isBroker', 'uploadedBy',
        ];
        for (const field of containsFields) {
            if (filters[field]) {
                where[field] = { contains: filters[field], mode: 'insensitive' };
            }
        }

        // Visibility ('visible' | 'hidden'). 'hidden' includes both false and null,
        // matching the old client-side semantics (anything not explicitly visible).
        if (filters.visibility === 'visible') {
            where.visibility = true;
        } else if (filters.visibility === 'hidden') {
            and.push({ OR: [{ visibility: false }, { visibility: null }] });
        }

        // Fire NOC lives on the WarehouseData relation. 'available' => true;
        // 'not_available' => everything else (false, null, or no WarehouseData row).
        if (filters.fireNoc === 'available') {
            and.push({ WarehouseData: { is: { fireNocAvailable: true } } });
        } else if (filters.fireNoc === 'not_available') {
            and.push({ NOT: { WarehouseData: { is: { fireNocAvailable: true } } } });
        }

        // Land type also lives on WarehouseData.
        if (filters.landType) {
            and.push({ WarehouseData: { is: { landType: { contains: filters.landType, mode: 'insensitive' } } } });
        }

        if (and.length > 0) where.AND = and;
        return where;
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
            processedData.availability = 'Yes';
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
     * Determines if contact info should be redacted.
     * Currently always true. When roles are added:
     *   return !options?.userRole || options.userRole !== 'admin';
     * @param {Object} options - Options that may contain role info
     * @returns {boolean} Whether to redact contact information
     */
    shouldRedactContact(options = {}) {
        return true;
    }

    /**
     * Transform warehouse data for response
     * @param {Object} warehouse - Raw warehouse data
     * @param {Object} options - Options for transformation (e.g. role context)
     * @returns {Object} Transformed warehouse data
     * @private
     */
    transformWarehouse(warehouse, options = {}) {
        if (!warehouse) return null;

        // Apply any business transformations
        const transformed = { ...warehouse };

        // Ensure consistent data structure
        if (!transformed.WarehouseData) {
            transformed.WarehouseData = {};
        }

        if (this.shouldRedactContact(options)) {
            delete transformed.contactNumber;
        }

        return transformed;
    }

    /**
     * Transform warehouse list for response
     * @param {Array} warehouses - Array of raw warehouse data
     * @param {Object} options - Options for transformation (e.g. role context)
     * @returns {Array} Array of transformed warehouse data
     * @private
     */
    transformWarehouseList(warehouses, options = {}) {
        return warehouses.map(warehouse => this.transformWarehouse(warehouse, options));
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