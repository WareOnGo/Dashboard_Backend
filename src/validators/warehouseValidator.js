// src/validators/warehouseValidator.js
const { z } = require('zod');
const BaseValidator = require('./baseValidator');

/**
 * Warehouse-specific validation schemas and utilities
 */
class WarehouseValidator extends BaseValidator {
    /**
     * Schema for nested WarehouseData
     */
    static warehouseDataSchema = z.object({
        latitude: z.number().optional().nullable(),
        longitude: z.number().optional().nullable(),
        fireNocAvailable: z.boolean().optional().nullable(),
        fireSafetyMeasures: z.string().optional().nullable(),
        landType: z.string().optional().nullable(),
        vaastuCompliance: z.string().optional().nullable(),
        approachRoadWidth: z.string().optional().nullable(),
        dimensions: z.string().optional().nullable(),
        parkingDockingSpace: z.string().optional().nullable(),
        pollutionZone: z.string().optional().nullable(),
        powerKva: z.string().optional().nullable(),
    });

    /**
     * Schema for creating a warehouse
     */
    static createWarehouseSchema = z.object({
        // Required fields
        warehouseType: z.string().min(1, "warehouseType is required"),
        address: z.string().min(1, "address is required"),
        city: z.string().min(1, "city is required"),
        state: z.string().min(1, "state is required"),
        zone: z.string().min(1, "zone is required"),
        contactPerson: z.string().min(1, "contactPerson is required"),
        contactNumber: z.string().min(1, "contactNumber is required"),
        totalSpaceSqft: z.array(z.number().int()).min(1, "totalSpaceSqft is required"),
        compliances: z.string().min(1, "compliances is required"),
        ratePerSqft: z.string().min(1, "ratePerSqft is required"),
        uploadedBy: z.string().min(1, "uploadedBy is required"),
        
        // Optional/Nullable fields
        warehouseOwnerType: z.string().optional().nullable(),
        googleLocation: z.string().optional().nullable(),
        postalCode: z.string().optional().nullable(),
        offeredSpaceSqft: z.string().optional().nullable(),
        numberOfDocks: z.string().optional().nullable(),
        clearHeightFt: z.string().optional().nullable(),
        otherSpecifications: z.string().optional().nullable(),
        availability: z.string().optional().nullable(),
        visibility: z.boolean().optional().nullable(),
        isBroker: z.string().optional().nullable(),
        photos: z.string().optional().nullable(),
        
        // Nested object
        warehouseData: this.warehouseDataSchema,
    });

    /**
     * Schema for updating a warehouse (all fields are optional)
     */
    static updateWarehouseSchema = this.createWarehouseSchema.partial();

    /**
     * Schema for warehouse ID parameter
     */
    static warehouseIdSchema = z.object({
        id: z.string().regex(/^\d+$/, "ID must be a valid number").transform(Number)
    });

    /**
     * Schema for warehouse query parameters
     */
    static warehouseQuerySchema = z.object({
        page: z.string().regex(/^\d+$/).transform(Number).optional(),
        limit: z.string().regex(/^\d+$/).transform(Number).optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zone: z.string().optional(),
        warehouseType: z.string().optional(),
        minSpace: z.string().regex(/^\d+$/).transform(Number).optional(),
        maxSpace: z.string().regex(/^\d+$/).transform(Number).optional(),
        sortBy: z.enum(['createdAt', 'totalSpaceSqft', 'ratePerSqft']).optional(),
        sortOrder: z.enum(['asc', 'desc']).optional()
    });

    /**
     * Schema for file upload request
     */
    static fileUploadSchema = z.object({
        contentType: z.string().min(1, "contentType is required")
            .refine(
                (type) => type.startsWith('image/') || type.startsWith('application/pdf'),
                "contentType must be an image or PDF"
            )
    });

    /**
     * Validate warehouse creation data
     * @param {Object} data - Data to validate
     * @returns {Object} Validation result
     */
    static validateCreate(data) {
        return this.validate(this.createWarehouseSchema, data);
    }

    /**
     * Validate warehouse update data
     * @param {Object} data - Data to validate
     * @returns {Object} Validation result
     */
    static validateUpdate(data) {
        return this.validate(this.updateWarehouseSchema, data);
    }

    /**
     * Validate warehouse ID parameter
     * @param {Object} params - Parameters to validate
     * @returns {Object} Validation result
     */
    static validateId(params) {
        return this.validate(this.warehouseIdSchema, params);
    }

    /**
     * Validate warehouse query parameters
     * @param {Object} query - Query parameters to validate
     * @returns {Object} Validation result
     */
    static validateQuery(query) {
        return this.validate(this.warehouseQuerySchema, query);
    }

    /**
     * Validate file upload request
     * @param {Object} data - Data to validate
     * @returns {Object} Validation result
     */
    static validateFileUpload(data) {
        return this.validate(this.fileUploadSchema, data);
    }

    /**
     * Validate and throw error if validation fails for warehouse creation
     * @param {Object} data - Data to validate
     * @returns {Object} Validated data
     * @throws {Error} If validation fails
     */
    static validateCreateOrThrow(data) {
        return this.validateOrThrow(this.createWarehouseSchema, data);
    }

    /**
     * Validate and throw error if validation fails for warehouse update
     * @param {Object} data - Data to validate
     * @returns {Object} Validated data
     * @throws {Error} If validation fails
     */
    static validateUpdateOrThrow(data) {
        return this.validateOrThrow(this.updateWarehouseSchema, data);
    }

    /**
     * Validate and throw error if validation fails for warehouse ID
     * @param {Object} params - Parameters to validate
     * @returns {Object} Validated parameters
     * @throws {Error} If validation fails
     */
    static validateIdOrThrow(params) {
        return this.validateOrThrow(this.warehouseIdSchema, params);
    }

    /**
     * Validate and throw error if validation fails for file upload
     * @param {Object} data - Data to validate
     * @returns {Object} Validated data
     * @throws {Error} If validation fails
     */
    static validateFileUploadOrThrow(data) {
        return this.validateOrThrow(this.fileUploadSchema, data);
    }
}

module.exports = WarehouseValidator;