const { registerWarehouseImages } = require('./imagePipelineRepository.cjs');
// src/models/stagedWarehouseModel.js
const BaseModel = require('./baseModel');
const { photosToMedia } = require('../utils/mediaUtils');
const { atomicPromotion } = require('./atomicPromotion');

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
            const rows = await this.model.findMany({
                where: reviewStatus ? { reviewStatus } : undefined,
                orderBy: { submittedAt: 'desc' },
                omit: { rawPayload: true, flags: true, reviewMeta: true },
                skip,
                take,
            });
            return this.annotateWarehouseExistence(rows);
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
            const row = await this.model.findUnique({ where: { id } });
            if (!row) return null;
            await this.annotateWarehouseExistence([row]);
            return row;
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Annotate each row with `warehouseDeleted` — true when an APPROVED row still
     * points at a master Warehouse (`warehouseId`) that no longer exists. Computed
     * at read time (one batched existence query) so the review panel reflects
     * reality no matter how the warehouse was removed — direct API delete, manual
     * DB delete, or future code — with no stored flag to keep in sync. The
     * `warehouseId` column has no FK, so this is the source of truth for the UI.
     *
     * Best-effort: if the existence check fails, rows are left unflagged
     * (warehouseDeleted=false) so a live listing is never falsely marked deleted.
     * @param {Array<Object>} rows
     * @returns {Promise<Array<Object>>} the same rows, each with `warehouseDeleted: boolean`
     * @private
     */
    async annotateWarehouseExistence(rows) {
        const ids = [...new Set(
            rows
                .filter((r) => r.reviewStatus === 'APPROVED' && r.warehouseId != null)
                .map((r) => r.warehouseId),
        )];

        let liveIds = new Set();
        if (ids.length) {
            try {
                const found = await this.prisma.warehouse.findMany({
                    where: { id: { in: ids } },
                    select: { id: true },
                });
                liveIds = new Set(found.map((w) => w.id));
            } catch (err) {
                console.error('StagedWarehouseModel: warehouse existence check failed', err.message);
                for (const row of rows) row.warehouseDeleted = false;
                return rows;
            }
        }

        for (const row of rows) {
            row.warehouseDeleted = row.reviewStatus === 'APPROVED'
                && row.warehouseId != null
                && !liveIds.has(row.warehouseId);
        }
        return rows;
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
            // One database statement: a failed DELETE rolls back the staging reset
            // too, without an interactive transaction through the pooler. The
            // snapshot guards stop a stale review page from revoking a newer claim.
            // DELETE depends on UPDATE's RETURNING result, so a lost claim cannot
            // remove a warehouse. An already absent warehouse is a valid no-op.
            const rows = await this.prisma.$queryRaw`
                WITH reopened AS (
                    UPDATE "StagedWarehouse"
                    SET "reviewStatus" = 'PENDING', "warehouseId" = NULL,
                        "reviewedBy" = NULL, "reviewedAt" = NULL, "rejectionReason" = NULL
                    WHERE id = ${row.id}
                        AND "reviewStatus" IN ('APPROVED', 'REJECTED')
                        AND "reviewStatus"::text = ${row.reviewStatus}
                        AND "warehouseId" IS NOT DISTINCT FROM ${row.warehouseId ?? null}::integer
                        AND "reviewedBy" IS NOT DISTINCT FROM ${row.reviewedBy ?? null}::text
                        AND "reviewedAt" IS NOT DISTINCT FROM ${row.reviewedAt ?? null}::timestamp
                    RETURNING *
                ), removed AS (
                    DELETE FROM "Warehouse"
                    WHERE id = ${row.warehouseId ?? null}::integer
                        AND ${row.reviewStatus}::text = 'APPROVED'
                        AND EXISTS (SELECT 1 FROM reopened)
                    RETURNING id
                )
                SELECT reopened.*, EXISTS (SELECT 1 FROM removed) AS "_warehouseRemoved"
                FROM reopened
            `;
            if (!rows.length) {
                throw conflict('Submission changed or is no longer approved/rejected. Refresh before reopening.');
            }
            const { _warehouseRemoved, ...reopened } = rows[0];

            await this.prisma.auditLog.create({
                data: {
                    action: 'REOPEN',
                    entity: 'staged_warehouse',
                    entityId: row.id,
                    context: `Moved staged warehouse ${row.id} back to PENDING (was ${row.reviewStatus})`,
                    metadata: {
                        previousStatus: row.reviewStatus,
                        previousWarehouseId: row.warehouseId ?? null,
                        removedWarehouseId: _warehouseRemoved ? row.warehouseId : null,
                    },
                    userEmail: reviewer.email,
                    userName: reviewer.name || null,
                    ipAddress: reviewer.ip || null,
                },
            }).catch((auditError) => {
                console.error('StagedWarehouseModel: failed to write REOPEN audit', auditError.message);
            });

            return reopened;
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Create the master, its details and the approval link in one SQL statement.
     * Consumers only see committed, linked promotions. Row locking preserves
     * single-winner approval without interactive pooler transactions.
     */
    async promote(id, payload, reviewer) {
        try {
            const { warehouseData = {}, media: incomingMedia, ...warehouse } = payload;
            if (warehouse.photos && !incomingMedia) warehouse.media = photosToMedia(warehouse.photos);
            else if (incomingMedia) warehouse.media = incomingMedia;
            const created = await atomicPromotion(this.prisma, id, warehouse, warehouseData, reviewer);
            if (!created) throw conflict('Submission is not in a reviewable state (already approved or rejected).');

            // Audit and registration run after the atomic promotion commits.
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

            await registerWarehouseImages(this.prisma, created.id);
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
