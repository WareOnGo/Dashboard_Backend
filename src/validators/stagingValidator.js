// src/validators/stagingValidator.js
const { z } = require('zod');
const WarehouseValidator = require('./warehouseValidator');

/**
 * Validation schemas for the staging / review API.
 */
class StagingValidator {
    /** Query params for the review queue list. */
    static listQuerySchema = z.object({
        // IN_REVIEW remains in the DB enum (to avoid a risky Postgres enum rebuild) but is
        // unreachable in the app, so it is not an accepted filter value.
        reviewStatus: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
    });

    /** Staged row id (uuid) route param. */
    static idSchema = z.object({
        id: z.string().uuid('id must be a valid uuid'),
    });

    /**
     * Edit body — a partial warehouse payload (same shape/coercion as the create
     * schema, all fields optional). The service whitelists which columns are
     * editable; unknown keys are stripped by Zod.
     */
    static editSchema = WarehouseValidator.updateWarehouseSchema;

    /** Reject body. */
    static rejectSchema = z.object({
        rejectionReason: z.string().trim().min(1, 'rejectionReason is required'),
    });

    /**
     * Generic webhook ingest body (POST /api/staging/ingest). Relaxed accept-and-store:
     * every field is optional (createWarehouseSchema.partial()) so partial/messy payloads
     * are stored for review rather than bounced at the door. The submission is re-validated
     * strictly with createWarehouseSchema at approval before it can reach the master table.
     */
    static ingestSchema = WarehouseValidator.updateWarehouseSchema;
}

module.exports = StagingValidator;
