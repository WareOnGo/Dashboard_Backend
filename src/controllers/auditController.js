// src/controllers/auditController.js
const BaseController = require('./baseController');

/**
 * AuditController — endpoints where the client reports something the backend
 * cannot observe itself.
 *
 * Today that is only PPT exports: the browser posts straight to the proposal
 * engine, so the dashboard backend never sees the request and cannot log it
 * server-side. Proxying it was rejected (it would stack a 10-minute generation
 * behind App Runner's own timeouts), so the client reports its own export.
 *
 * What that costs and what it does not, per PPT_AUDIT_SPEC.md:
 *  - The details are client-asserted, and calling the engine's public URL
 *    directly bypasses the log entirely. Accepted: the goal is visibility into
 *    normal dashboard use, not a tamper-evident egress record.
 *  - Attribution is NOT client-asserted. The acting user comes from the verified
 *    JWT via req.audit(), never from the body, and `action`/`entity` are
 *    hardcoded below. Keep it that way: a client-callable sink that could write
 *    arbitrary action/entity values would make every trustworthy row already in
 *    audit_logs — logins, deletes, contact reveals — forgeable.
 */
class AuditController extends BaseController {
    /**
     * Record a PPT export the client just performed.
     * POST /api/audit/ppt-export
     *
     * Body is validated by AuditValidator.pptExportSchema, which is strict and
     * has no action/entity/userEmail fields to begin with.
     */
    logPptExport = this.asyncHandler(async (req, res, next) => {
        try {
            const {
                variant, warehouseIds, outcome, httpStatus, bytes, durationMs,
                clientName, companyName, clientRequirement, errorMessage, selectedImageCount,
            } = req.body;

            const client = clientName || companyName;
            const forClient = client ? ` for ${client}` : '';
            const failure = outcome === 'failed'
                ? ` — FAILED${httpStatus ? ` (HTTP ${httpStatus})` : ''}`
                : '';
            const count = warehouseIds.length;
            const warehouses = `${count} warehouse${count === 1 ? '' : 's'}`;

            const metadata = {
                variant,
                warehouseIds,
                warehouseCount: count,
                outcome,
                httpStatus,
                bytes,
                durationMs,
                clientName,
                companyName,
                clientRequirement,
                errorMessage,
                selectedImageCount,
                // Marks the row as client-asserted, so a reader isn't misled
                // into treating it like a server-observed entry.
                reportedBy: 'client',
            };
            // Optional fields the client omitted would otherwise land as JSON nulls.
            for (const key of Object.keys(metadata)) {
                if (metadata[key] === undefined) delete metadata[key];
            }

            // action and entity are hardcoded, never read from the body.
            req.audit(
                'EXPORT',
                'presentation',
                null,
                `Exported ${variant} PPT (${warehouses})${forClient}${failure}`,
                metadata,
            );

            // The client fires this without awaiting a body.
            this.sendNoContent(res);
        } catch (error) {
            next(error);
        }
    });
}

module.exports = AuditController;
