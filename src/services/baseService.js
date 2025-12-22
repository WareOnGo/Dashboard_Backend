// src/services/baseService.js
/**
 * Base service class providing common business logic patterns
 */
class BaseService {
    constructor() {
        // Base service initialization
    }

    /**
     * Validate data using a provided validator
     * @param {*} data - Data to validate
     * @param {Function} validator - Validation function
     * @returns {Object} Validation result
     * @throws {Error} If validation fails
     */
    validateData(data, validator) {
        const result = validator(data);
        if (!result.success) {
            const error = new Error('Validation failed');
            error.name = 'ValidationError';
            error.issues = result.error.issues;
            throw error;
        }
        return result.data;
    }

    /**
     * Transform data for business logic processing
     * @param {*} data - Raw data
     * @returns {*} Transformed data
     */
    transformData(data) {
        // Base implementation - can be overridden by subclasses
        return data;
    }

    /**
     * Apply business rules to data
     * @param {*} data - Data to process
     * @returns {*} Processed data
     */
    applyBusinessRules(data) {
        // Base implementation - can be overridden by subclasses
        return data;
    }

    /**
     * Handle service-level errors
     * @param {Error} error - Error to handle
     * @throws {Error} Processed error
     */
    handleError(error) {
        // Log error for debugging
        console.error(`Service Error: ${error.message}`, error);
        
        // Re-throw with additional context if needed
        throw error;
    }

    /**
     * Execute a service operation with error handling
     * @param {Function} operation - Operation to execute
     * @returns {*} Operation result
     */
    async executeOperation(operation) {
        try {
            return await operation();
        } catch (error) {
            this.handleError(error);
        }
    }
}

module.exports = BaseService;