// src/models/imageLabelModel.js
const { Prisma } = require('@prisma/client');
const BaseModel = require('./baseModel');

/**
 * ImageLabelModel — persistence for labeled_warehouse_images (see
 * prisma/schema.prisma LabeledWarehouseImage).
 *
 * The central query is findUnlabelled(): it asks "which images in Warehouse.media
 * have no label row?" rather than "what changed recently?". That makes the sweep
 * source-agnostic — it picks up dashboard submissions, scout submissions, partner
 * API ingests, direct PUT edits and out-of-band database changes alike, with no
 * per-writer hook to keep in sync.
 */
class ImageLabelModel extends BaseModel {
    constructor(prismaClient = null) {
        super(prismaClient);
        this.model = this.prisma.labeledWarehouseImage;
    }

    /**
     * Images present in Warehouse.media with no row in labeled_warehouse_images.
     *
     * Newest warehouses first, so a backlog larger than `limit` still labels the
     * most recently submitted listings on the next sweep rather than starving
     * them behind old rows.
     *
     * @param {number} limit - Maximum rows to return
     * @returns {Promise<Array<{warehouseId: number, imageUrl: string}>>}
     */
    async findUnlabelled(limit) {
        try {
            return await this.prisma.$queryRaw`
                SELECT DISTINCT ON (img #>> '{}')
                       w.id AS "warehouseId",
                       img #>> '{}' AS "imageUrl"
                FROM "Warehouse" w,
                     LATERAL jsonb_array_elements(COALESCE(w.media::jsonb->'images', '[]'::jsonb)) img
                WHERE jsonb_typeof(img) = 'string'
                  AND img #>> '{}' ~* '\.(jpe?g|png|webp|gif)$'
                  AND NOT EXISTS (
                      SELECT 1 FROM labeled_warehouse_images l
                      WHERE l."imageUrl" = img #>> '{}'
                  )
                ORDER BY img #>> '{}', w.id DESC
                LIMIT ${limit}
            `;
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Count of images still awaiting a label. Used for reporting backlog without
     * pulling the rows themselves.
     * @returns {Promise<number>}
     */
    async countUnlabelled() {
        try {
            const rows = await this.prisma.$queryRaw`
                SELECT COUNT(*)::int AS n FROM (
                    SELECT DISTINCT img #>> '{}' AS url
                    FROM "Warehouse" w,
                         LATERAL jsonb_array_elements(COALESCE(w.media::jsonb->'images', '[]'::jsonb)) img
                    WHERE jsonb_typeof(img) = 'string'
                      AND img #>> '{}' ~* '\.(jpe?g|png|webp|gif)$'
                      AND NOT EXISTS (
                          SELECT 1 FROM labeled_warehouse_images l
                          WHERE l."imageUrl" = img #>> '{}'
                      )
                ) t
            `;
            return rows[0]?.n ?? 0;
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Insert label rows, ignoring any whose imageUrl is already present.
     *
     * createMany rather than an interactive transaction: the Supabase pooler does
     * not support those (P2028). skipDuplicates makes concurrent sweeps and
     * retried chunks harmless.
     *
     * @param {Array<Object>} rows
     * @returns {Promise<number>} Number actually inserted
     */
    async createManyLabels(rows) {
        try {
            const { count } = await this.model.createMany({ data: rows, skipDuplicates: true });
            return count;
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Labels for one warehouse's images, in media order.
     *
     * Joins on imageUrl rather than warehouseId: rows are deduped by URL, so a
     * label's warehouseId is whichever listing the image was first seen on. If
     * two warehouses share an image, filtering by warehouseId would silently
     * drop the label for one of them.
     *
     * LEFT JOIN so unlabelled images still come back (with nulls), letting the
     * caller distinguish "not labelled yet" from "not an image".
     *
     * @param {number} warehouseId
     * @returns {Promise<Array<{imageUrl: string, classification: string|null, description: string|null, confidence: number|null}>>}
     */
    async findForWarehouse(warehouseId) {
        try {
            return await this.prisma.$queryRaw`
                SELECT img #>> '{}'   AS "imageUrl",
                       l.classification,
                       l.description,
                       l.confidence
                FROM "Warehouse" w
                CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.media::jsonb->'images', '[]'::jsonb))
                     WITH ORDINALITY AS t(img, ord)
                LEFT JOIN labeled_warehouse_images l ON l."imageUrl" = img #>> '{}'
                WHERE w.id = ${warehouseId}
                  AND jsonb_typeof(img) = 'string'
                ORDER BY t.ord
            `;
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Labels for several warehouses at once, in media order within each.
     *
     * Exists so a list view can warm its cache in one round trip instead of one
     * per row — the query itself costs ~0.2ms, so N requests would be paying
     * ~245ms of network latency N times over for nothing.
     *
     * Same URL join as findForWarehouse, for the same reason: label rows are
     * deduped by imageUrl, so warehouseId on the row is not reliable.
     *
     * @param {number[]} warehouseIds
     * @returns {Promise<Array<{warehouseId: number, imageUrl: string, classification: string|null, description: string|null, confidence: number|null}>>}
     */
    async findForWarehouses(warehouseIds) {
        if (!warehouseIds.length) return [];
        try {
            return await this.prisma.$queryRaw`
                SELECT w.id AS "warehouseId",
                       img #>> '{}'   AS "imageUrl",
                       l.classification,
                       l.description,
                       l.confidence
                FROM "Warehouse" w
                CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.media::jsonb->'images', '[]'::jsonb))
                     WITH ORDINALITY AS t(img, ord)
                LEFT JOIN labeled_warehouse_images l ON l."imageUrl" = img #>> '{}'
                WHERE w.id IN (${Prisma.join(warehouseIds)})
                  AND jsonb_typeof(img) = 'string'
                ORDER BY w.id, t.ord
            `;
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * How many rows pruneStale() would remove. Used by the dry run so the prune
     * can be inspected before it deletes anything.
     * @returns {Promise<number>}
     */
    async countStale() {
        try {
            const rows = await this.prisma.$queryRaw`
                SELECT COUNT(*)::int AS n FROM labeled_warehouse_images l
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM "Warehouse" w,
                         LATERAL jsonb_array_elements(COALESCE(w.media::jsonb->'images', '[]'::jsonb)) img
                    WHERE img #>> '{}' = l."imageUrl"
                )
            `;
            return rows[0]?.n ?? 0;
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Delete label rows whose imageUrl no longer appears in any Warehouse.media
     * images array.
     *
     * Covers both ways a row goes stale — the warehouse was deleted, or the
     * image was removed from the listing during an edit — because it keys on the
     * URL still being referenced rather than on the warehouse still existing. A
     * foreign key would only catch the first.
     *
     * Safe by construction: a URL that is still referenced anywhere is kept, and
     * if a deleted image is later re-added the sweep simply re-labels it.
     *
     * @returns {Promise<number>} Rows deleted
     */
    async pruneStale() {
        try {
            return await this.prisma.$executeRaw`
                DELETE FROM labeled_warehouse_images l
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM "Warehouse" w,
                         LATERAL jsonb_array_elements(COALESCE(w.media::jsonb->'images', '[]'::jsonb)) img
                    WHERE img #>> '{}' = l."imageUrl"
                )
            `;
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Label counts by classification, for the stats endpoint.
     * @returns {Promise<Array<{classification: string, count: number}>>}
     */
    async countByClassification() {
        try {
            const rows = await this.model.groupBy({ by: ['classification'], _count: true });
            return rows
                .map((r) => ({ classification: r.classification, count: r._count }))
                .sort((a, b) => b.count - a.count);
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /** Total number of label rows. @returns {Promise<number>} */
    async countAll() {
        try {
            return await this.model.count();
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }
}

module.exports = ImageLabelModel;
