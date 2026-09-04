// src/controllers/pptController.js
const BaseController = require('./baseController');
const { logError, logWarn, logInfo } = require('../ppt/utils/logger');

const PPTX_CONTENT_TYPE =
    'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/**
 * PptController — warehouse proposal deck generation.
 *
 * Merged in from the standalone Warehouse Proposal Engine. Previously the
 * browser posted straight to that service, which meant (a) the endpoints had no
 * authentication at all and (b) the backend never saw an export, so
 * POST /api/audit/ppt-export had to accept a client-*reported* row. Both are
 * fixed by serving the decks from here: the routes sit behind the normal JWT +
 * capability gate, and the audit entry below is server-observed.
 *
 * ---------------------------------------------------------------------------
 * Timeouts: App Runner terminates any request at ~120s and that is not
 * configurable. The engine set a 10-minute server timeout and the browser a
 * 10-minute abort, but neither was ever reachable — the platform cut the
 * connection at 2 minutes while Node kept generating (observed: an 18-minute
 * run that logged success for a deck nobody received). Detailed decks are the
 * only variant that gets near this; see the audit rows for the real rate.
 * ---------------------------------------------------------------------------
 */
class PptController extends BaseController {
    /**
     * @param {PptGenerationService} pptGenerationService
     * @param {AuditLogService} auditLogService
     */
    constructor(pptGenerationService, auditLogService) {
        super();
        this.pptGenerationService = pptGenerationService;
        this.auditLogService = auditLogService;
    }

    /**
     * Write the export audit row.
     *
     * Deliberately calls auditLogService directly instead of req.audit(): the
     * audit middleware flushes on res.on('finish'), which does NOT fire when the
     * client has already gone away (verified — an aborted socket emits 'close'
     * only). Since the failure we most need visibility into is exactly the
     * request App Runner killed at ~120s, routing through req.audit() would drop
     * those rows and make the timeout look like it never happens.
     *
     * Fire-and-forget: AuditLogService.log() swallows its own errors, and a
     * failed audit write must never fail a deck the user is waiting on.
     *
     * @param {express.Request} req
     * @param {Object} details - variant, warehouseIds, outcome, timing, sizes
     */
    recordExport(req, details) {
        const {
            variant, warehouseIds, outcome, httpStatus,
            bytes, durationMs, errorMessage, customDetails = {}, selectedImages = {},
        } = details;

        const clientName = customDetails.clientName?.trim() || undefined;
        const companyName = customDetails.companyName?.trim() || undefined;
        const client = clientName || companyName;
        const count = warehouseIds.length;

        const context =
            `${variant} ${variant === 'last-mile' ? 'workbook' : 'deck'} — ${count} warehouse${count === 1 ? '' : 's'}` +
            (client ? ` for ${client}` : '') +
            (outcome === 'failed' ? ` — FAILED${httpStatus ? ` (HTTP ${httpStatus})` : ''}` : '') +
            (outcome === 'abandoned' ? ' — ABANDONED (client disconnected before delivery)' : '');

        this.auditLogService.log({
            action: 'EXPORT',
            entity: 'presentation',
            entityId: null,
            context,
            metadata: {
                variant,
                warehouseIds,
                warehouseCount: count,
                outcome,
                httpStatus,
                bytes,
                durationMs,
                clientName,
                companyName,
                clientRequirement: customDetails.clientRequirement?.trim() || undefined,
                errorMessage,
                selectedImageCount: Object.values(selectedImages)
                    .reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0),
                // Server-observed, unlike the legacy client-reported rows which
                // carry reportedBy: 'client'. Keep this so the two eras of data
                // stay distinguishable.
                reportedBy: 'server',
            },
            userEmail: req.user?.email || 'anonymous',
            userName: req.user?.name || null,
            ipAddress: req.ip || req.connection?.remoteAddress || null,
        });
    }

    /**
     * Build an export end to end: parse ids, load warehouses, generate,
     * stream back the file, and audit the outcome either way.
     *
     * Routes select the variant, response type, error wording, and whether an
     * empty id list is allowed (TCI only). Defaults preserve the PPT contract.
     *
     * @param {Object} opts
     * @param {string} opts.variant - Template key, including 'last-mile' for XLSX
     * @param {string} opts.label - human label used in error messages
     * @param {boolean} [opts.allowEmptyIds] - TCI falls back to placeholder data
     * @param {string} [opts.contentType] - Download MIME type; defaults to PPTX
     * @param {string} [opts.fileType] - File type used in errors; defaults to PPT
     * @returns {Function} Express handler
     */
    handleGenerate({ variant, label, allowEmptyIds = false, contentType = PPTX_CONTENT_TYPE, fileType = 'PPT' }) {
        return this.asyncHandler(async (req, res) => {
            const { ids, selectedImages = {}, customDetails = {}, includeLocation = false } = req.body || {};
            const warehouseIds = this.pptGenerationService.parseIds(ids);
            const startedAt = Date.now();

            // Did the caller hang up before we could answer? A deck the client
            // never received is not a success, however well generation went, and
            // this is the shape every App Runner ~120s kill takes: the socket
            // dies, Node keeps building, and the finished buffer goes nowhere.
            // Recorded as its own outcome so the abandoned rate is one query.
            let clientGone = false;
            res.on('close', () => { if (!res.writableFinished) clientGone = true; });

            const audit = (outcome, extra = {}) => this.recordExport(req, {
                variant, warehouseIds, customDetails, selectedImages,
                outcome: clientGone && outcome === 'success' ? 'abandoned' : outcome,
                durationMs: Date.now() - startedAt, ...extra,
            });

            if (warehouseIds.length === 0 && !allowEmptyIds) {
                logWarn('pptController', variant, 'Invalid or no warehouse IDs provided', { bodyIds: ids });
                audit('failed', { httpStatus: 400, errorMessage: 'Invalid or no Warehouse IDs provided.' });
                return res.status(400).json({ error: 'Invalid or no Warehouse IDs provided.' });
            }

            try {
                let warehouses = [];
                if (warehouseIds.length > 0) {
                    warehouses = await this.pptGenerationService.findWarehousesByIds(warehouseIds);
                    if (!warehouses || warehouses.length === 0) {
                        logWarn('pptController', variant, 'Warehouses not found', { warehouseIds });
                        const message = `Warehouses with IDs ${warehouseIds.join(', ')} not found.`;
                        audit('failed', { httpStatus: 404, errorMessage: message });
                        return res.status(404).json({ error: message });
                    }
                } else {
                    logInfo('pptController', variant, 'No ids supplied, using placeholder data');
                }

                logInfo('pptController', variant, `Generating ${label} presentation`, {
                    warehouseIds, warehouseCount: warehouses.length,
                });

                const buffer = await this.pptGenerationService.createBuffer(
                    variant, warehouses, selectedImages, customDetails, includeLocation
                );

                logInfo('pptController', variant, `Successfully generated ${label} presentation`, {
                    warehouseIds, bufferSize: buffer.length, durationMs: Date.now() - startedAt,
                });

                res.setHeader('Content-Type', contentType);
                res.send(buffer);

                // Audited after the send attempt so a client that already hung up
                // is seen as such rather than logged as a delivered export.
                audit('success', { httpStatus: 200, bytes: buffer.length });
                return;
            } catch (error) {
                logError('pptController', variant, `Failed to generate ${label} ${fileType}`, {
                    warehouseIds, error: error.message, stack: error.stack,
                });
                audit('failed', { httpStatus: 500, errorMessage: error.message });
                return res.status(500).json({
                    error: `An internal server error occurred during ${label} ${fileType} generation.`,
                });
            }
        });
    }
}

module.exports = PptController;
