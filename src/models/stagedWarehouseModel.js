// src/models/stagedWarehouseModel.js
const BaseModel = require('./baseModel');
const { photosToMedia } = require('../utils/mediaUtils');

/** Build a 409 conflict error consistent with ErrorHandler.createConflictError. */
function conflict(message) {
    const error = new Error(message);
    error.name = 'ConflictError';
    error.statusCode = 409;
    return error;
}

const REVIEWABLE = ['PENDING'];

/**
 * StagedWarehouseModel handles persistence for the staging / validation layer.
 * Staged rows mirror the Warehouse columns (all nullable) plus the nested
 * WarehouseData fields flattened to the top level, so a single staged row holds
 * a complete promotion payload. See docs/STAGING_VALIDATION_LAYER.md.
 */
class StagedWarehouseModel extends BaseModel {
    constructor(prismaClient = null) {
        super(prismaClient);
        this.model = this.prisma.stagedWarehouse;
    }

    /**
     * Create a staged submission row.
     * @param {Object} data - Flattened staged warehouse data (already mapped by the service)
     * @returns {Object} Created staged row
     */
    async create(data) {
        try {
            return await this.model.create({ data });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Find staged rows, newest first, optionally filtered by review status.
     * The heavy reserved JSON columns (rawPayload/flags/reviewMeta) are omitted —
     * they are not used by the review UI and rawPayload duplicates the whole row.
     * Fetch a single row via findByStagedId when the full snapshot is needed.
     * @param {Object} options
     * @param {string} [options.reviewStatus] - Filter by StagingStatus
     * @param {number} [options.skip]
     * @param {number} [options.take]
     * @returns {Array} Staged rows (without rawPayload/flags/reviewMeta)
     */
    async findAll({ reviewStatus, skip, take } = {}) {
        try {
            return await this.model.findMany({
                where: reviewStatus ? { reviewStatus } : undefined,
                orderBy: { submittedAt: 'desc' },
                omit: { rawPayload: true, flags: true, reviewMeta: true },
                skip,
                take,
            });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Find a staged row by its uuid id.
     * @param {string} id
     * @returns {Object|null}
     */
    async findByStagedId(id) {
        try {
            return await this.model.findUnique({ where: { id } });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Delete a staged row by its uuid id. Does not touch any promoted master Warehouse.
     * @param {string} id
     * @returns {Object} The deleted row
     */
    async deleteStaged(id) {
        try {
            return await this.model.delete({ where: { id } });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Apply reviewer edits to a staged row. The row stays PENDING.
     * @param {string} id
     * @param {Object} data - Whitelisted column edits (already mapped by the service)
     * @returns {Object} Updated staged row
     */
    async updateStaged(id, data) {
        try {
            return await this.model.update({
                where: { id },
                data,
            });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Move an APPROVED or REJECTED row back to PENDING.
     * Revoking an APPROVED row also deletes the master Warehouse it was promoted to
     * (cascading WarehouseData), so it leaves the live list. Idempotent guard: only
     * APPROVED/REJECTED rows can be reopened.
     * @param {Object} row - The current staged row (for previous status + warehouseId)
     * @param {Object} reviewer - { email, name?, ip? }
     * @returns {Object} The reopened (PENDING) staged row
     * @throws {Error} ConflictError(409) if the row is not APPROVED/REJECTED
     */
    async reopen(row, reviewer) {
        try {
            const claim = await this.model.updateMany({
                where: { id: row.id, reviewStatus: { in: ['APPROVED', 'REJECTED'] } },
                data: { reviewStatus: 'PENDING', warehouseId: null, reviewedBy: null, reviewedAt: null, rejectionReason: null },
            });
            if (claim.count === 0) {
                throw conflict('Only approved or rejected submissions can be moved back to pending.');
            }

            // Revoking an approval pulls the promoted warehouse back out of the master table.
            if (row.reviewStatus === 'APPROVED' && row.warehouseId) {
                await this.prisma.warehouse.delete({ where: { id: row.warehouseId } })
                    .catch(() => { /* already removed */ });
            }

            await this.prisma.auditLog.create({
                data: {
                    action: 'REOPEN',
                    entity: 'staged_warehouse',
                    entityId: row.id,
                    context: `Moved staged warehouse ${row.id} back to PENDING (was ${row.reviewStatus})`,
                    metadata: {
                        previousStatus: row.reviewStatus,
                        removedWarehouseId: row.reviewStatus === 'APPROVED' ? row.warehouseId : null,
                    },
                    userEmail: reviewer.email,
                    userName: reviewer.name || null,
                    ipAddress: reviewer.ip || null,
                },
            }).catch((auditError) => {
                console.error('StagedWarehouseModel: failed to write REOPEN audit', auditError.message);
            });

            return this.model.findUnique({ where: { id: row.id } });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Promote a staged row into the master Warehouse table.
     *
     * Uses a claim-first + compensation pattern (no interactive transaction —
     * those are unreliable through the Supabase pooler, P2028). The optimistic
     * claim is a single atomic statement, so only one approval can win and a
     * duplicate Warehouse can never be created. If the Warehouse insert fails,
     * the claim is reverted to PENDING so it returns to the queue and can be retried.
     *
     * @param {string} id - Staged row id
     * @param {Object} payload - Promotion payload { ...warehouseFields, warehouseData, media? }
     * @param {Object} reviewer - { email, name?, ip? }
     * @returns {Object} The created master Warehouse (with WarehouseData)
     * @throws {Error} ConflictError(409) if the row is not in a reviewable state
     */
    async promote(id, payload, reviewer) {
        try {
            // 1. Atomic optimistic claim — guards against double-approval.
            const claim = await this.model.updateMany({
                where: { id, reviewStatus: { in: REVIEWABLE } },
                data: { reviewStatus: 'APPROVED', reviewedBy: reviewer.email, reviewedAt: new Date() },
            });
            if (claim.count === 0) {
                throw conflict('Submission is not in a reviewable state (already approved or rejected).');
            }

            // 2. Create the master Warehouse. On failure, release the claim so it can be retried.
            const { warehouseData, media: incomingMedia, ...warehouse } = payload;
            if (warehouse.photos && !incomingMedia) {
                warehouse.media = photosToMedia(warehouse.photos);
            } else if (incomingMedia) {
                warehouse.media = incomingMedia;
            }

            let created;
            try {
                created = await this.prisma.warehouse.create({
                    data: { ...warehouse, WarehouseData: { create: warehouseData } },
                    include: { WarehouseData: true },
                });
            } catch (createError) {
                await this.model.updateMany({
                    where: { id },
                    data: { reviewStatus: 'PENDING', reviewedBy: null, reviewedAt: null },
                }).catch(() => { /* best-effort compensation */ });
                throw createError;
            }

            // 3. Link the staged row to the promoted warehouse.
            await this.model.update({ where: { id }, data: { warehouseId: created.id } });

            // 4. Audit (awaited, immediately after the claim; non-fatal like AuditLogService).
            await this.prisma.auditLog.create({
                data: {
                    action: 'APPROVE',
                    entity: 'staged_warehouse',
                    entityId: id,
                    context: `Approved staged warehouse ${id} -> warehouse ${created.id}`,
                    metadata: { warehouseId: created.id, source: 'STAGING_REVIEW' },
                    userEmail: reviewer.email,
                    userName: reviewer.name || null,
                    ipAddress: reviewer.ip || null,
                },
            }).catch((auditError) => {
                console.error('StagedWarehouseModel: failed to write APPROVE audit', auditError.message);
            });

            return created;
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Reject a staged row. The optimistic claim is a single atomic statement;
     * the audit entry is written immediately after (non-fatal).
     * @param {string} id
     * @param {Object} reviewer - { email, name?, ip? }
     * @param {string} rejectionReason
     * @returns {Object} Updated staged row
     * @throws {Error} ConflictError(409) if not in a reviewable state
     */
    async reject(id, reviewer, rejectionReason) {
        try {
            const claim = await this.model.updateMany({
                where: { id, reviewStatus: { in: REVIEWABLE } },
                data: {
                    reviewStatus: 'REJECTED',
                    reviewedBy: reviewer.email,
                    reviewedAt: new Date(),
                    rejectionReason,
                },
            });
            if (claim.count === 0) {
                throw conflict('Submission is not in a reviewable state (already approved or rejected).');
            }

            await this.prisma.auditLog.create({
                data: {
                    action: 'REJECT',
                    entity: 'staged_warehouse',
                    entityId: id,
                    context: `Rejected staged warehouse ${id}`,
                    metadata: { rejectionReason },
                    userEmail: reviewer.email,
                    userName: reviewer.name || null,
                    ipAddress: reviewer.ip || null,
                },
            }).catch((auditError) => {
                console.error('StagedWarehouseModel: failed to write REJECT audit', auditError.message);
            });

            return this.model.findUnique({ where: { id } });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }
}

module.exports = StagedWarehouseModel;
