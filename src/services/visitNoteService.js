// src/services/visitNoteService.js
const BaseService = require('./baseService');

const clientError = (message, statusCode) => {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
};

/**
 * VisitNoteService — CRUD for warehouse visit notes.
 * Single-statement operations only (no interactive transactions) to stay safe
 * on the Supabase pooler. Creator identity is stamped from the JWT.
 */
class VisitNoteService extends BaseService {
    /**
     * @param {VisitNoteModel} visitNoteModel
     */
    constructor(visitNoteModel) {
        super();
        this.visitNoteModel = visitNoteModel;
    }

    listForWarehouse(warehouseId) {
        return this.executeOperation(() => this.visitNoteModel.listByWarehouseId(warehouseId));
    }

    create(warehouseId, { client, clientPoc, wareOnGoPoc, visitDate, clientFeedback, pocFeedback }, user) {
        return this.executeOperation(async () => {
            try {
                return await this.visitNoteModel.createOne({
                    warehouseId: Number(warehouseId),
                    client,
                    clientPoc: clientPoc ?? null,
                    wareOnGoPoc: wareOnGoPoc ?? null,
                    visitDate,
                    clientFeedback: clientFeedback ?? null,
                    pocFeedback: pocFeedback ?? null,
                    createdByEmail: user?.email || null,
                    createdByName: user?.name || null,
                });
            } catch (err) {
                // P2003: FK violation — the warehouse doesn't exist.
                if (err.code === 'P2003') throw clientError('Warehouse not found', 404);
                throw err;
            }
        });
    }

    update(warehouseId, noteId, updates) {
        return this.executeOperation(async () => {
            const existing = await this.visitNoteModel.getById(noteId);
            // Scope to the warehouse in the URL so a note can't be edited
            // through another warehouse's route.
            if (!existing || existing.warehouseId !== Number(warehouseId)) {
                throw clientError('Visit note not found', 404);
            }
            const data = {};
            for (const field of ['client', 'clientPoc', 'wareOnGoPoc', 'visitDate', 'clientFeedback', 'pocFeedback']) {
                if (updates[field] !== undefined) data[field] = updates[field];
            }
            try {
                return await this.visitNoteModel.updateById(noteId, data);
            } catch (err) {
                if (err.code === 'P2025') throw clientError('Visit note not found', 404);
                throw err;
            }
        });
    }

    remove(warehouseId, noteId) {
        return this.executeOperation(async () => {
            const existing = await this.visitNoteModel.getById(noteId);
            if (!existing || existing.warehouseId !== Number(warehouseId)) {
                // Idempotent: deleting a missing note is a no-op success.
                return;
            }
            try {
                await this.visitNoteModel.deleteById(noteId);
            } catch (err) {
                if (err.code !== 'P2025') throw err;
            }
        });
    }
}

module.exports = VisitNoteService;
