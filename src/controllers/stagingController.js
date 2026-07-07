// src/controllers/stagingController.js
const BaseController = require('./baseController');
const gupshupService = require('../services/gupshupService');

/**
 * StagingController — admin-facing review API for the validation layer.
 * List / view / edit / approve / reject staged warehouse submissions.
 * See docs/STAGING_VALIDATION_LAYER.md.
 */
class StagingController extends BaseController {
    /**
     * @param {StagingService} stagingService
     * @param {SettingsService} settingsService
     */
    constructor(stagingService, settingsService) {
        super();
        this.stagingService = stagingService;
        this.settingsService = settingsService;
    }

    /** GET /api/staging/settings/auto-approve — current autopilot state (reviewer-visible). */
    getAutoApprove = this.asyncHandler(async (req, res, next) => {
        try {
            const enabled = await this.settingsService.getAutoApprove();
            this.sendSuccess(res, { enabled });
        } catch (error) {
            this.handleServiceError(res, error, next);
        }
    });

    /** PATCH /api/staging/settings/auto-approve — flip autopilot (admin-only). Body: { enabled: boolean }. */
    setAutoApprove = this.asyncHandler(async (req, res, next) => {
        try {
            if (typeof req.body?.enabled !== 'boolean') {
                return this.sendError(res, 'Body must include a boolean "enabled".', 400);
            }
            const enabled = await this.settingsService.setAutoApprove(req.body.enabled, req.user.email);
            req.audit('UPDATE', 'app_setting', 'auto_approve_submissions',
                `Auto-approve ${enabled ? 'ENABLED' : 'DISABLED'}`, { enabled });
            this.sendSuccess(res, { enabled });
        } catch (error) {
            this.handleServiceError(res, error, next);
        }
    });

    /**
     * Map service-thrown client errors (4xx) to responses; let 5xx bubble to the
     * global handler. The global handler only honors statusCode for ValidationError,
     * so NotFound/Conflict are rendered here.
     * @private
     */
    handleServiceError(res, error, next) {
        if (error && error.statusCode && error.statusCode < 500) {
            const details = error.issues ? { issues: error.issues } : null;
            return this.sendError(res, error.message, error.statusCode, details);
        }
        return next(error);
    }

    /**
     * POST /api/staging/ingest — generic external webhook ingest (NOT admin-gated;
     * authenticated by the shared webhook secret middleware). Accept-and-store:
     * the body passed only the relaxed ingestSchema, so it may be partial.
     */
    ingestSubmission = this.asyncHandler(async (req, res, next) => {
        try {
            const source = req.webhookSource?.source || 'PARTNER_API';
            const submittedBy = `webhook:${source.toLowerCase()}`;
            const staged = await this.stagingService.createIngestSubmission({
                submission: req.body,
                source,
                submittedBy,
            });

            // No JWT user on a webhook; label the audit actor explicitly.
            req.user = { email: submittedBy };
            req.audit('CREATE', 'staged_warehouse', staged.id, `Ingested ${source} warehouse`, {
                source, // matches the staged row's `source` value
                reviewStatus: staged.reviewStatus,
                city: req.body?.city,
                state: req.body?.state,
            });

            this.sendCreated(res, staged);
        } catch (error) {
            this.handleServiceError(res, error, next);
        }
    });

    /** GET /api/staging?reviewStatus=&page=&limit= */
    listSubmissions = this.asyncHandler(async (req, res, next) => {
        try {
            const { reviewStatus, page, limit } = req.validatedQuery || {};
            const submissions = await this.stagingService.listSubmissions({ reviewStatus, page, limit });

            req.audit('READ', 'staged_warehouse', null, 'Listed staged submissions', {
                reviewStatus: reviewStatus || 'ALL',
                resultCount: submissions.length,
            });

            this.sendSuccess(res, submissions);
        } catch (error) {
            this.handleServiceError(res, error, next);
        }
    });

    /** GET /api/staging/:id */
    getSubmission = this.asyncHandler(async (req, res, next) => {
        try {
            const submission = await this.stagingService.getSubmission(req.params.id);
            req.audit('READ', 'staged_warehouse', req.params.id, `Viewed staged warehouse ${req.params.id}`);
            this.sendSuccess(res, submission);
        } catch (error) {
            this.handleServiceError(res, error, next);
        }
    });

    /** PATCH /api/staging/:id */
    updateSubmission = this.asyncHandler(async (req, res, next) => {
        try {
            const { submission, changes } = await this.stagingService.editSubmission(req.params.id, req.body);

            req.audit('UPDATE', 'staged_warehouse', req.params.id, `Edited staged warehouse ${req.params.id}`, {
                changes,
            });

            this.sendSuccess(res, submission);
        } catch (error) {
            this.handleServiceError(res, error, next);
        }
    });

    /** POST /api/staging/:id/approve */
    approveSubmission = this.asyncHandler(async (req, res, next) => {
        try {
            const reviewer = { email: req.user.email, name: req.user.name, ip: req.ip };
            // The APPROVE audit entry is written by the model, right after the atomic status claim.
            const warehouse = await this.stagingService.approveSubmission(req.params.id, reviewer);

            // Best-effort WhatsApp notification to the submitter (no-op unless the feature flag is on).
            // Source the message from the promoted warehouse itself so any reviewer edits made
            // before approval are reflected. uploadedBy carries through as the original submitter.
            const notification = await gupshupService.notifyReviewDecision({
                outcome: 'APPROVED',
                row: { ...warehouse, submittedBy: warehouse.uploadedBy },
                warehouseId: warehouse.id,
            });

            this.sendCreated(res, { ...warehouse, notification });
        } catch (error) {
            this.handleServiceError(res, error, next);
        }
    });

    /** POST /api/staging/:id/reject */
    rejectSubmission = this.asyncHandler(async (req, res, next) => {
        try {
            const reviewer = { email: req.user.email, name: req.user.name, ip: req.ip };
            // The REJECT audit entry is written by the model, right after the atomic status claim.
            const submission = await this.stagingService.rejectSubmission(
                req.params.id,
                reviewer,
                req.body.rejectionReason,
            );

            // Best-effort WhatsApp notification to the submitter (no-op unless the feature flag is on).
            const notification = await gupshupService.notifyReviewDecision({
                outcome: 'REJECTED',
                row: submission,
            });

            this.sendSuccess(res, { ...submission, notification });
        } catch (error) {
            this.handleServiceError(res, error, next);
        }
    });

    /** POST /api/staging/:id/reopen — move an approved/rejected row back to PENDING */
    reopenSubmission = this.asyncHandler(async (req, res, next) => {
        try {
            const reviewer = { email: req.user.email, name: req.user.name, ip: req.ip };
            const submission = await this.stagingService.reopenSubmission(req.params.id, reviewer);
            this.sendSuccess(res, submission);
        } catch (error) {
            this.handleServiceError(res, error, next);
        }
    });

    /** DELETE /api/staging/:id — delete a staged submission (leaves any promoted warehouse) */
    deleteSubmission = this.asyncHandler(async (req, res, next) => {
        try {
            const result = await this.stagingService.deleteSubmission(req.params.id);
            req.audit('DELETE', 'staged_warehouse', req.params.id, `Deleted staged warehouse ${req.params.id}`, {
                previousStatus: result.previousStatus,
                warehouseId: result.warehouseId,
            });
            this.sendNoContent(res);
        } catch (error) {
            this.handleServiceError(res, error, next);
        }
    });
}

module.exports = StagingController;
