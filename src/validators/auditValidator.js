// src/validators/auditValidator.js
const { z } = require('zod');
const BaseValidator = require('./baseValidator');

/**
 * PPT variants the dashboard can export. Matches the four wrappers in the
 * frontend's pptService.js; the deprecated V1 ("standard") variant was dropped
 * and is deliberately not accepted. Append here when a new variant ships —
 * an unknown variant is rejected rather than stored, so the column stays a
 * usable facet.
 */
const PPT_VARIANTS = ['detailed', 'v2', 'godamwale', 'tci'];

/** Hard ceilings. app.js allows a 10mb JSON body, so every field needs a bound. */
const MAX_WAREHOUSE_IDS = 200;

/** Long free-text is truncated rather than rejected — a failed export is still worth a row. */
const truncated = (max) => z.string().max(max * 4).transform((s) => s.slice(0, max));

/**
 * Validation for the client-reported audit endpoints.
 *
 * These bodies come from the browser, so the schema is `.strict()` and every
 * field is bounded. Note what is NOT here: `action`, `entity`, `userEmail`.
 * Those are set server-side (the first two hardcoded in the controller, the
 * last from the verified JWT) precisely so a client cannot forge a row as
 * another user or another action — see PPT_AUDIT_SPEC.md §2.
 */
class AuditValidator extends BaseValidator {
    /**
     * Schema for POST /api/audit/ppt-export.
     */
    static pptExportSchema = z.object({
        variant: z.enum(PPT_VARIANTS),
        warehouseIds: z.array(z.number().int().positive()).max(MAX_WAREHOUSE_IDS),
        outcome: z.enum(['success', 'failed']),
        httpStatus: z.number().int().min(100).max(599).optional(),
        bytes: z.number().int().min(0).optional(),
        durationMs: z.number().int().min(0).optional(),
        clientName: truncated(200).optional(),
        companyName: truncated(200).optional(),
        clientRequirement: truncated(500).optional(),
        errorMessage: truncated(500).optional(),
        selectedImageCount: z.number().int().min(0).optional(),
    }).strict();
}

AuditValidator.PPT_VARIANTS = PPT_VARIANTS;

module.exports = AuditValidator;
