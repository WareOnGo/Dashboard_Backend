// src/middleware/validation.js
const { z } = require('zod');
const ErrorHandler = require('./errorHandler');
const WarehouseValidator = require('../validators/warehouseValidator');

/**
 * Validation middleware for Express routes
 * Provides utilities for validating request data using Zod schemas
 */
class ValidationMiddleware {
    /**
     * Create validation middleware for request body
     * @param {z.ZodSchema} schema - Zod schema to validate against
     * @returns {Function} Express middleware function
     */
    static validateBody(schema) {
        return (req, res, next) => {
            try {
                const result = schema.safeParse(req.body);
                
                if (!result.success) {
                    const error = ErrorHandler.createValidationError(
                        'Request body validation failed',
                        result.error.issues
                    );
                    return next(error);
                }
                
                // Replace req.body with validated and potentially transformed data
                req.body = result.data;
                next();
            } catch (error) {
                next(error);
            }
        };
    }

    /**
     * Create validation middleware for query parameters
     * @param {z.ZodSchema} schema - Zod schema to validate against
     * @returns {Function} Express middleware function
     */
    static validateQuery(schema) {
        return (req, res, next) => {
            try {
                const result = schema.safeParse(req.query);
                
                if (!result.success) {
                    const error = ErrorHandler.createValidationError(
                        'Query parameters validation failed',
                        result.error.issues
                    );
                    return next(error);
                }
                
                // Note: In Express 5.x, req.query is read-only
                // We store validated data in a separate property
                req.validatedQuery = result.data;
                next();
            } catch (error) {
                next(error);
            }
        };
    }

    /**
     * Create validation middleware for route parameters
     * @param {z.ZodSchema} schema - Zod schema to validate against
     * @returns {Function} Express middleware function
     */
    static validateParams(schema) {
        return (req, res, next) => {
            try {
                const result = schema.safeParse(req.params);
                
                if (!result.success) {
                    const error = ErrorHandler.createValidationError(
                        'Route parameters validation failed',
                        result.error.issues
                    );
                    return next(error);
                }
                
                // Replace req.params with validated and potentially transformed data
                req.params = result.data;
                next();
            } catch (error) {
                next(error);
            }
        };
    }

    /**
     * Create validation middleware for multiple request parts
     * @param {Object} schemas - Object containing schemas for different parts
     * @param {z.ZodSchema} schemas.body - Schema for request body
     * @param {z.ZodSchema} schemas.query - Schema for query parameters
     * @param {z.ZodSchema} schemas.params - Schema for route parameters
     * @returns {Function} Express middleware function
     */
    static validate(schemas) {
        return (req, res, next) => {
            try {
                const errors = [];

                // Validate body if schema provided
                if (schemas.body) {
                    const bodyResult = schemas.body.safeParse(req.body);
                    if (!bodyResult.success) {
                        errors.push(...bodyResult.error.issues.map(issue => ({
                            ...issue,
                            location: 'body'
                        })));
                    } else {
                        req.body = bodyResult.data;
                    }
                }

                // Validate query if schema provided
                if (schemas.query) {
                    const queryResult = schemas.query.safeParse(req.query);
                    if (!queryResult.success) {
                        errors.push(...queryResult.error.issues.map(issue => ({
                            ...issue,
                            location: 'query'
                        })));
                    } else {
                        // Note: In Express 5.x, req.query is read-only
                        // We store validated data in a separate property
                        req.validatedQuery = queryResult.data;
                    }
                }

                // Validate params if schema provided
                if (schemas.params) {
                    const paramsResult = schemas.params.safeParse(req.params);
                    if (!paramsResult.success) {
                        errors.push(...paramsResult.error.issues.map(issue => ({
                            ...issue,
                            location: 'params'
                        })));
                    } else {
                        req.params = paramsResult.data;
                    }
                }

                // If there are validation errors, create and pass error
                if (errors.length > 0) {
                    const error = ErrorHandler.createValidationError(
                        'Request validation failed',
                        errors
                    );
                    return next(error);
                }

                next();
            } catch (error) {
                next(error);
            }
        };
    }

    /**
     * Sanitize string input by trimming whitespace and removing null bytes
     * @param {string} input - Input string to sanitize
     * @returns {string} Sanitized string
     */
    static sanitizeString(input) {
        if (typeof input !== 'string') {
            return input;
        }
        
        return input
            .trim()
            .replace(/\0/g, ''); // Remove null bytes
    }

    /**
     * Sanitize object by applying string sanitization to all string properties
     * @param {Object} obj - Object to sanitize
     * @returns {Object} Sanitized object
     */
    static sanitizeObject(obj) {
        if (!obj || typeof obj !== 'object') {
            return obj;
        }

        const sanitized = {};
        
        for (const [key, value] of Object.entries(obj)) {
            if (typeof value === 'string') {
                sanitized[key] = this.sanitizeString(value);
            } else if (Array.isArray(value)) {
                sanitized[key] = value.map(item => 
                    typeof item === 'string' ? this.sanitizeString(item) : item
                );
            } else if (value && typeof value === 'object') {
                sanitized[key] = this.sanitizeObject(value);
            } else {
                sanitized[key] = value;
            }
        }

        return sanitized;
    }

    /**
     * Middleware to sanitize request body
     * @returns {Function} Express middleware function
     */
    static sanitizeBody() {
        return (req, res, next) => {
            if (req.body) {
                req.body = this.sanitizeObject(req.body);
            }
            next();
        };
    }

    /**
     * Middleware to sanitize query parameters
     * @returns {Function} Express middleware function
     */
    static sanitizeQuery() {
        return (req, res, next) => {
            // Note: In Express 5.x, req.query is read-only
            // We skip sanitizing query params to avoid errors
            // Query validation should be done through validation middleware instead
            next();
        };
    }

    /**
     * Middleware to sanitize all request data
     * @returns {Function} Express middleware function
     */
    static sanitizeAll() {
        return (req, res, next) => {
            if (req.body) {
                req.body = this.sanitizeObject(req.body);
            }
            // Note: In Express 5.x, req.query is read-only
            // We skip sanitizing query params to avoid errors
            // Query validation should be done through validation middleware instead
            if (req.params) {
                req.params = this.sanitizeObject(req.params);
            }
            next();
        };
    }

    // --- Warehouse-specific validation middleware ---

    /**
     * Middleware to validate warehouse creation request
     * @returns {Function} Express middleware function
     */
    static validateWarehouseCreate = this.validateBody(WarehouseValidator.createWarehouseSchema);

    /**
     * Middleware to validate warehouse update request
     * @returns {Function} Express middleware function
     */
    static validateWarehouseUpdate = this.validateBody(WarehouseValidator.updateWarehouseSchema);

    /**
     * Middleware to validate warehouse ID parameter
     * @returns {Function} Express middleware function
     */
    static validateWarehouseId = this.validateParams(WarehouseValidator.warehouseIdSchema);

    /**
     * Middleware to validate warehouse query parameters
     * @returns {Function} Express middleware function
     */
    static validateWarehouseQuery = this.validateQuery(WarehouseValidator.warehouseQuerySchema);

    /**
     * Middleware to validate file upload request
     * @returns {Function} Express middleware function
     */
    static validateFileUpload = this.validateBody(WarehouseValidator.fileUploadSchema);

    /**
     * Middleware to validate batch file upload request
     * @returns {Function} Express middleware function
     */
    static validateBatchFileUpload = this.validateBody(z.object({
        uploadRequests: z.array(WarehouseValidator.fileUploadSchema).min(1).max(10),
        expiresIn: z.number().optional(),
        keyPrefix: z.string().optional(),
        uploadedBy: z.string().optional()
    }));
}

module.exports = ValidationMiddleware;