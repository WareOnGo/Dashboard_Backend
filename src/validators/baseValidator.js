// src/validators/baseValidator.js
const { z } = require('zod');

/**
 * Base validator class providing common validation patterns
 */
class BaseValidator {
    /**
     * Validate data against a Zod schema
     * @param {z.ZodSchema} schema - Zod schema to validate against
     * @param {*} data - Data to validate
     * @returns {Object} Validation result
     */
    static validate(schema, data) {
        return schema.safeParse(data);
    }

    /**
     * Validate and throw error if validation fails
     * @param {z.ZodSchema} schema - Zod schema to validate against
     * @param {*} data - Data to validate
     * @returns {*} Validated data
     * @throws {Error} If validation fails
     */
    static validateOrThrow(schema, data) {
        const result = this.validate(schema, data);
        if (!result.success) {
            const error = new Error('Validation failed');
            error.name = 'ValidationError';
            error.issues = result.error.issues;
            throw error;
        }
        return result.data;
    }

    /**
     * Common validation schemas
     */
    static commonSchemas = {
        id: z.number().int().positive(),
        email: z.string().email(),
        phone: z.string().min(10).max(15),
        url: z.string().url(),
        positiveNumber: z.number().positive(),
        nonEmptyString: z.string().min(1),
        optionalString: z.string().optional().nullable(),
        boolean: z.boolean(),
        date: z.date(),
        isoDateString: z.string().datetime()
    };

    /**
     * Create a pagination schema
     * @param {number} maxLimit - Maximum allowed limit
     * @returns {z.ZodSchema} Pagination schema
     */
    static createPaginationSchema(maxLimit = 100) {
        return z.object({
            page: z.number().int().min(1).default(1),
            limit: z.number().int().min(1).max(maxLimit).default(10),
            sortBy: z.string().optional(),
            sortOrder: z.enum(['asc', 'desc']).default('desc')
        });
    }

    /**
     * Create a search schema
     * @returns {z.ZodSchema} Search schema
     */
    static createSearchSchema() {
        return z.object({
            query: z.string().min(1),
            fields: z.array(z.string()).optional()
        });
    }
}

module.exports = BaseValidator;