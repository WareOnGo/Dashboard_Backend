// src/controllers/visitNoteController.js
const BaseController = require('./baseController');

/**
 * VisitNoteController — CRUD for warehouse visit notes, nested under
 * /api/warehouses/:id/visit-notes.
 */
class VisitNoteController extends BaseController {
    /**
     * @param {VisitNoteService} visitNoteService
     */
    constructor(visitNoteService) {
        super();
        this.visitNoteService = visitNoteService;
    }

    /** Map service-thrown client errors (4xx) to responses; let 5xx bubble. */
    handleServiceError(res, error, next) {
        if (error && error.statusCode && error.statusCode < 500) {
            return this.sendError(res, error.message, error.statusCode);
        }
        return next(error);
    }

    /** GET /api/warehouses/:id/visit-notes */
    list = this.asyncHandler(async (req, res, next) => {
        try {
            const warehouseId = this.extractId(req);
            const notes = await this.visitNoteService.listForWarehouse(warehouseId);

            req.audit('READ', 'visit_note', null, `Listed visit notes for warehouse ${warehouseId}`, {
                warehouseId,
                resultCount: notes.length,
            });

            this.sendSuccess(res, notes);
        } catch (error) {
            this.handleServiceError(res, error, next);
        }
    });

    /** POST /api/warehouses/:id/visit-notes */
    create = this.asyncHandler(async (req, res, next) => {
        try {
            const warehouseId = this.extractId(req);
            const note = await this.visitNoteService.create(warehouseId, req.body, req.user);

            req.audit('CREATE', 'visit_note', note.id, `Added visit note for warehouse ${warehouseId}`, {
                warehouseId,
                client: note.client,
            });

            this.sendCreated(res, note);
        } catch (error) {
            this.handleServiceError(res, error, next);
        }
    });

    /** PUT /api/warehouses/:id/visit-notes/:noteId */
    update = this.asyncHandler(async (req, res, next) => {
        try {
            const warehouseId = this.extractId(req);
            const noteId = this.extractId(req, 'noteId');
            const note = await this.visitNoteService.update(warehouseId, noteId, req.body);

            req.audit('UPDATE', 'visit_note', noteId, `Updated visit note ${noteId} on warehouse ${warehouseId}`, {
                warehouseId,
            });

            this.sendSuccess(res, note);
        } catch (error) {
            this.handleServiceError(res, error, next);
        }
    });

    /** DELETE /api/warehouses/:id/visit-notes/:noteId */
    remove = this.asyncHandler(async (req, res, next) => {
        try {
            const warehouseId = this.extractId(req);
            const noteId = this.extractId(req, 'noteId');
            await this.visitNoteService.remove(warehouseId, noteId);

            req.audit('DELETE', 'visit_note', noteId, `Deleted visit note ${noteId} on warehouse ${warehouseId}`, {
                warehouseId,
            });

            this.sendNoContent(res);
        } catch (error) {
            this.handleServiceError(res, error, next);
        }
    });
}

module.exports = VisitNoteController;
