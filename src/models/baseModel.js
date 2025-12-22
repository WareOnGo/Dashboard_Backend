// src/models/baseModel.js
const database = require('../utils/database');

/**
 * Base model class providing common database operations and patterns
 */
class BaseModel {
    constructor(prismaClient = null) {
        // Use provided client or get from database utility
        this.prisma = prismaClient || database.getClient();
        this.model = null; // To be set by subclasses
    }

    /**
     * Find all records with optional filtering and pagination
     * @param {Object} options - Query options
     * @param {Object} options.where - Where conditions
     * @param {Object} options.include - Relations to include
     * @param {Object} options.orderBy - Ordering options
     * @param {number} options.skip - Number of records to skip
     * @param {number} options.take - Number of records to take
     * @returns {Array} Array of records
     */
    async findMany(options = {}) {
        try {
            return await this.model.findMany(options);
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Find a single record by ID
     * @param {number} id - Record ID
     * @param {Object} options - Query options
     * @returns {Object|null} Record or null if not found
     */
    async findById(id, options = {}) {
        try {
            return await this.model.findUnique({
                where: { id: parseInt(id) },
                ...options
            });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Find a single record by conditions
     * @param {Object} where - Where conditions
     * @param {Object} options - Query options
     * @returns {Object|null} Record or null if not found
     */
    async findFirst(where, options = {}) {
        try {
            return await this.model.findFirst({
                where,
                ...options
            });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Create a new record
     * @param {Object} data - Data to create
     * @param {Object} options - Query options
     * @returns {Object} Created record
     */
    async create(data, options = {}) {
        try {
            return await this.model.create({
                data,
                ...options
            });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Update a record by ID
     * @param {number} id - Record ID
     * @param {Object} data - Data to update
     * @param {Object} options - Query options
     * @returns {Object} Updated record
     */
    async update(id, data, options = {}) {
        try {
            return await this.model.update({
                where: { id: parseInt(id) },
                data,
                ...options
            });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Delete a record by ID
     * @param {number} id - Record ID
     * @returns {Object} Deleted record
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
     * Count records with optional filtering
     * @param {Object} where - Where conditions
     * @returns {number} Count of records
     */
    async count(where = {}) {
        try {
            return await this.model.count({ where });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Check if a record exists
     * @param {Object} where - Where conditions
     * @returns {boolean} True if record exists
     */
    async exists(where) {
        try {
            const count = await this.model.count({ where });
            return count > 0;
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Handle database errors with appropriate error types
     * @param {Error} error - Database error
     * @throws {Error} Processed error
     */
    handleDatabaseError(error) {
        console.error(`Database Error in ${this.constructor.name}:`, error);
        
        // Re-throw the error to be handled by upper layers
        throw error;
    }

    /**
     * Execute a database transaction
     * @param {Function} operations - Operations to execute in transaction
     * @returns {*} Transaction result
     */
    async transaction(operations) {
        try {
            return await this.prisma.$transaction(operations);
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }
}

module.exports = BaseModel;