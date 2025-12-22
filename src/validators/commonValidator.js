// src/validators/commonValidator.js
const { z } = require('zod');
const BaseValidator = require('./baseValidator');

/**
 * Common validation schemas and utilities used across the application
 */
class CommonValidator extends BaseValidator {
    /**
     * Schema for pagination parameters
     */
    static paginationSchema = z.object({
        page: z.string().regex(/^\d+$/).transform(Number).refine(val => val >= 1, "Page must be at least 1").default(1),
        limit: z.string().regex(/^\d+$/).transform(Number).refine(val => val >= 1 && val <= 100, "Limit must be between 1 and 100").default(10),
        sortBy: z.string().optional(),
        sortOrder: z.enum(['asc', 'desc']).default('desc')
    });

    /**
     * Schema for search parameters
     */
    static searchSchema = z.object({
        query: z.string().min(1, "Search query is required"),
        fields: z.array(z.string()).optional()
    });

    /**
     * Schema for ID parameter (numeric)
     */
    static idParamSchema = z.object({
        id: z.string().regex(/^\d+$/, "ID must be a valid number").transform(Number)
    });

    /**
     * Schema for UUID parameter
     */
    static uuidParamSchema = z.object({
        id: z.string().uuid("ID must be a valid UUID")
    });

    /**
     * Schema for file upload content type validation
     */
    static contentTypeSchema = z.string()
        .min(1, "Content type is required")
        .refine(
            (type) => {
                const allowedTypes = [
                    'image/jpeg',
                    'image/jpg', 
                    'image/png',
                    'image/gif',
                    'image/webp',
                    'application/pdf',
                    'text/csv',
                    'application/vnd.ms-excel',
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                ];
                return allowedTypes.includes(type);
            },
            "Invalid content type. Allowed types: images, PDF, CSV, Excel"
        );

    /**
     * Schema for date range filtering
     */
    static dateRangeSchema = z.object({
        startDate: z.string().datetime().optional(),
        endDate: z.string().datetime().optional()
    }).refine(
        (data) => {
            if (data.startDate && data.endDate) {
                return new Date(data.startDate) <= new Date(data.endDate);
            }
            return true;
        },
        "Start date must be before or equal to end date"
    );

    /**
     * Schema for coordinates (latitude, longitude)
     */
    static coordinatesSchema = z.object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180)
    });

    /**
     * Schema for contact information
     */
    static contactSchema = z.object({
        name: z.string().min(1, "Name is required"),
        email: z.string().email("Invalid email format").optional(),
        phone: z.string().min(10, "Phone number must be at least 10 digits").optional()
    }).refine(
        (data) => data.email || data.phone,
        "Either email or phone number is required"
    );

    /**
     * Schema for address information
     */
    static addressSchema = z.object({
        street: z.string().min(1, "Street address is required"),
        city: z.string().min(1, "City is required"),
        state: z.string().min(1, "State is required"),
        postalCode: z.string().optional(),
        country: z.string().default("India")
    });

    /**
     * Validate pagination parameters
     * @param {Object} query - Query parameters to validate
     * @returns {Object} Validation result
     */
    static validatePagination(query) {
        return this.validate(this.paginationSchema, query);
    }

    /**
     * Validate search parameters
     * @param {Object} query - Query parameters to validate
     * @returns {Object} Validation result
     */
    static validateSearch(query) {
        return this.validate(this.searchSchema, query);
    }

    /**
     * Validate ID parameter
     * @param {Object} params - Parameters to validate
     * @returns {Object} Validation result
     */
    static validateIdParam(params) {
        return this.validate(this.idParamSchema, params);
    }

    /**
     * Validate UUID parameter
     * @param {Object} params - Parameters to validate
     * @returns {Object} Validation result
     */
    static validateUuidParam(params) {
        return this.validate(this.uuidParamSchema, params);
    }

    /**
     * Validate content type
     * @param {string} contentType - Content type to validate
     * @returns {Object} Validation result
     */
    static validateContentType(contentType) {
        return this.validate(this.contentTypeSchema, contentType);
    }

    /**
     * Validate date range
     * @param {Object} query - Query parameters to validate
     * @returns {Object} Validation result
     */
    static validateDateRange(query) {
        return this.validate(this.dateRangeSchema, query);
    }

    /**
     * Validate coordinates
     * @param {Object} data - Coordinates data to validate
     * @returns {Object} Validation result
     */
    static validateCoordinates(data) {
        return this.validate(this.coordinatesSchema, data);
    }

    /**
     * Validate contact information
     * @param {Object} data - Contact data to validate
     * @returns {Object} Validation result
     */
    static validateContact(data) {
        return this.validate(this.contactSchema, data);
    }

    /**
     * Validate address information
     * @param {Object} data - Address data to validate
     * @returns {Object} Validation result
     */
    static validateAddress(data) {
        return this.validate(this.addressSchema, data);
    }

    /**
     * Create a custom enum schema with error message
     * @param {Array} values - Allowed enum values
     * @param {string} fieldName - Name of the field for error message
     * @returns {z.ZodEnum} Zod enum schema
     */
    static createEnumSchema(values, fieldName = 'field') {
        return z.enum(values, {
            errorMap: () => ({
                message: `${fieldName} must be one of: ${values.join(', ')}`
            })
        });
    }

    /**
     * Create a numeric string schema that transforms to number
     * @param {Object} options - Validation options
     * @param {number} options.min - Minimum value
     * @param {number} options.max - Maximum value
     * @param {boolean} options.integer - Whether to enforce integer
     * @returns {z.ZodEffects} Zod schema
     */
    static createNumericStringSchema(options = {}) {
        let schema = z.string().regex(/^\d+(\.\d+)?$/, "Must be a valid number");
        
        if (options.integer) {
            schema = z.string().regex(/^\d+$/, "Must be a valid integer");
        }
        
        return schema.transform(Number).refine((num) => {
            if (options.min !== undefined && num < options.min) {
                return false;
            }
            if (options.max !== undefined && num > options.max) {
                return false;
            }
            return true;
        }, {
            message: `Number must be${options.min !== undefined ? ` at least ${options.min}` : ''}${options.max !== undefined ? ` at most ${options.max}` : ''}`
        });
    }

    /**
     * Create a file size validation schema
     * @param {number} maxSizeBytes - Maximum file size in bytes
     * @returns {z.ZodNumber} Zod schema
     */
    static createFileSizeSchema(maxSizeBytes = 10 * 1024 * 1024) { // 10MB default
        return z.number().max(maxSizeBytes, `File size must not exceed ${maxSizeBytes / (1024 * 1024)}MB`);
    }
}

module.exports = CommonValidator;