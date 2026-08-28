// src/controllers/verifiedNumberController.js
const BaseController = require('./baseController');
const { changeMetadata } = require('../utils/auditDiff');

/**
 * VerifiedNumberController — the POC picker list (any authenticated user) plus the
 * admin roster management used by the access-control panel.
 */
class VerifiedNumberController extends BaseController {
    /**
     * @param {VerifiedNumberService} verifiedNumberService
     */
    constructor(verifiedNumberService) {
        super();
        this.verifiedNumberService = verifiedNumberService;
    }

    /** Map service-thrown client errors (4xx) to responses; let 5xx bubble. */
    handleServiceError(res, error, next) {
        if (error && error.statusCode && error.statusCode < 500) {
            return this.sendError(res, error.message, error.statusCode, error.details || null);
        }
        return next(error);
    }

    actorFrom(req) {
        return { email: req.user?.email, name: req.user?.name };
    }

    /** A short label for audit context lines. */
    labelFor(row) {
        return row.name || row.email || row.empID || `#${row.id}`;
    }

    /** GET /api/verified-numbers — active verified numbers as { data: [...] } */
    list = this.asyncHandler(async (req, res, next) => {
        try {
            const rows = await this.verifiedNumberService.listActive();
            this.sendSuccess(res, { data: rows });
        } catch (error) {
            this.handleServiceError(res, error, next);
        }
    });

    /** GET /api/verified-numbers/admin — full roster for the admin panel */
    adminList = this.asyncHandler(async (req, res, next) => {
        try {
            // Express 5 makes req.query read-only, so validated params land here.
            const { search, includeInactive } = req.validatedQuery || {};
            const rows = await this.verifiedNumberService.list({ search, includeInactive });
            this.sendSuccess(res, { data: rows });
        } catch (error) {
            this.handleServiceError(res, error, next);
        }
    });

    /** POST /api/verified-numbers/admin — add an employee to the roster */
    adminCreate = this.asyncHandler(async (req, res, next) => {
        try {
            const row = await this.verifiedNumberService.create(req.body, this.actorFrom(req));
            if (typeof req.audit === 'function') {
                req.audit(
                    'CREATE',
                    'verified_number',
                    row.id,
                    `Added employee ${this.labelFor(row)}`,
                    // Record which capabilities the row was created with, so a grant made
                    // at creation time is as visible in the trail as one made by edit.
                    {
                        empID: row.empID,
                        adminAccess: row.adminAccess,
                        callDashboardAccess: row.callDashboardAccess,
                        dashboardAccess: row.dashboardAccess,
                        reviewerAccess: row.reviewerAccess,
                    }
                );
            }
            this.sendCreated(res, row);
        } catch (error) {
            this.handleServiceError(res, error, next);
        }
    });

    /** PATCH /api/verified-numbers/admin/:id — edit details or capabilities */
    adminUpdate = this.asyncHandler(async (req, res, next) => {
        try {
            // validateParams replaces req.params with the coerced values.
            const { id } = req.params;
            const { row, changes } = await this.verifiedNumberService.update(
                id,
                req.body,
                this.actorFrom(req)
            );
            if (typeof req.audit === 'function') {
                req.audit(
                    'UPDATE',
                    'verified_number',
                    row.id,
                    changes.length
                        ? `Updated ${this.labelFor(row)} — ${changes.map((c) => c.field).join(', ')}`
                        : `Updated ${this.labelFor(row)} — no field changed`,
                    changeMetadata(changes)
                );
            }
            this.sendSuccess(res, row);
        } catch (error) {
            this.handleServiceError(res, error, next);
        }
    });
}

module.exports = VerifiedNumberController;
