// src/models/warehouseModel.js
const BaseModel = require('./baseModel');

/**
 * WarehouseModel class for handling warehouse data operations
 * Extends BaseModel to provide warehouse-specific database operations
 */
class WarehouseModel extends BaseModel {
    constructor(prismaClient = null) {
        super(prismaClient);
        this.model = this.prisma.warehouse;
    }

    /**
     * Find all warehouses with WarehouseData relationships
     * @param {Object} options - Query options
     * @returns {Array} Array of warehouses with nested WarehouseData
     */
    async findAll(options = {}) {
        try {
            const defaultOptions = {
                include: { WarehouseData: true },
                orderBy: { createdAt: 'desc' },
                ...options
            };
            
            return await this.model.findMany(defaultOptions);
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Find a warehouse by ID with WarehouseData relationship
     * @param {number} id - Warehouse ID
     * @param {Object} options - Additional query options
     * @returns {Object|null} Warehouse with WarehouseData or null if not found
     */
    async findById(id, options = {}) {
        try {
            const defaultOptions = {
                include: { WarehouseData: true },
                ...options
            };
            
            return await this.model.findUnique({
                where: { id: parseInt(id) },
                ...defaultOptions
            });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Create a new warehouse with nested WarehouseData
     * @param {Object} warehouseData - Warehouse data including nested WarehouseData
     * @returns {Object} Created warehouse with WarehouseData
     */
    async create(warehouseData) {
        try {
            const { warehouseData: nestedData, ...warehouse } = warehouseData;

            return await this.model.create({
                data: {
                    ...warehouse,
                    WarehouseData: {
                        create: nestedData,
                    },
                },
                include: { WarehouseData: true },
            });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Update a warehouse by ID with optional WarehouseData updates
     * @param {number} id - Warehouse ID
     * @param {Object} updateData - Data to update including optional nested WarehouseData
     * @returns {Object} Updated warehouse with WarehouseData
     */
    async update(id, updateData) {
        try {
            const { warehouseData, ...warehouse } = updateData;

            const updatePayload = {
                where: { id: parseInt(id) },
                data: {
                    ...warehouse,
                    // Only update warehouseData if it was provided
                    ...(warehouseData && {
                        WarehouseData: {
                            update: warehouseData,
                        },
                    }),
                },
                include: { WarehouseData: true },
            };

            return await this.model.update(updatePayload);
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Delete a warehouse by ID (cascades to WarehouseData due to schema)
     * @param {number} id - Warehouse ID
     * @returns {Object} Deleted warehouse
     */
    async delete(id) {
        try {
            return await this.model.delete({
                where: { id: parseInt(id) }
            });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Search warehouses by various criteria
     * @param {Object} searchCriteria - Search parameters
     * @param {string} searchCriteria.city - City to search in
     * @param {string} searchCriteria.state - State to search in
     * @param {string} searchCriteria.warehouseType - Type of warehouse
     * @param {string} searchCriteria.zone - Zone to search in
     * @param {Array<number>} searchCriteria.minSpace - Minimum space requirements
     * @param {string} searchCriteria.maxRate - Maximum rate per sqft
     * @returns {Array} Array of matching warehouses
     */
    async search(searchCriteria) {
        try {
            const where = {};

            if (searchCriteria.city) {
                where.city = {
                    contains: searchCriteria.city,
                    mode: 'insensitive'
                };
            }

            if (searchCriteria.state) {
                where.state = {
                    contains: searchCriteria.state,
                    mode: 'insensitive'
                };
            }

            if (searchCriteria.warehouseType) {
                where.warehouseType = {
                    contains: searchCriteria.warehouseType,
                    mode: 'insensitive'
                };
            }

            if (searchCriteria.zone) {
                where.zone = {
                    contains: searchCriteria.zone,
                    mode: 'insensitive'
                };
            }

            if (searchCriteria.minSpace && Array.isArray(searchCriteria.minSpace)) {
                where.totalSpaceSqft = {
                    hasSome: searchCriteria.minSpace
                };
            }

            if (searchCriteria.maxRate) {
                // Note: ratePerSqft is stored as string, so this is a simple comparison
                where.ratePerSqft = {
                    lte: searchCriteria.maxRate
                };
            }

            return await this.model.findMany({
                where,
                include: { WarehouseData: true },
                orderBy: { createdAt: 'desc' }
            });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Get warehouses by location (city and state)
     * @param {string} city - City name
     * @param {string} state - State name
     * @returns {Array} Array of warehouses in the specified location
     */
    async findByLocation(city, state) {
        try {
            return await this.model.findMany({
                where: {
                    city: {
                        contains: city,
                        mode: 'insensitive'
                    },
                    state: {
                        contains: state,
                        mode: 'insensitive'
                    }
                },
                include: { WarehouseData: true },
                orderBy: { createdAt: 'desc' }
            });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Get warehouses by uploader
     * @param {string} uploadedBy - Name/ID of the uploader
     * @returns {Array} Array of warehouses uploaded by the specified user
     */
    async findByUploader(uploadedBy) {
        try {
            return await this.model.findMany({
                where: {
                    uploadedBy: {
                        contains: uploadedBy,
                        mode: 'insensitive'
                    }
                },
                include: { WarehouseData: true },
                orderBy: { createdAt: 'desc' }
            });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Get warehouse statistics
     * @returns {Object} Statistics about warehouses
     */
    async getStatistics() {
        try {
            const [
                totalCount,
                byType,
                byState,
                averageSpace
            ] = await Promise.all([
                this.model.count(),
                this.model.groupBy({
                    by: ['warehouseType'],
                    _count: true
                }),
                this.model.groupBy({
                    by: ['state'],
                    _count: true
                }),
                this.model.aggregate({
                    _avg: {
                        totalSpaceSqft: true
                    }
                })
            ]);

            return {
                totalWarehouses: totalCount,
                byType,
                byState,
                averageSpace: averageSpace._avg.totalSpaceSqft
            };
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Check if a warehouse exists by ID
     * @param {number} id - Warehouse ID
     * @returns {boolean} True if warehouse exists
     */
    async exists(id) {
        try {
            const count = await this.model.count({
                where: { id: parseInt(id) }
            });
            return count > 0;
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }
}

module.exports = WarehouseModel;