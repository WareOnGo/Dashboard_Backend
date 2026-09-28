const BaseService = require('./baseService');
const { serializeImage } = require('../utils/imageContract.cjs');

const JOB_NAME = 'sweep_warehouse_image_labels';
const DEFAULT_MODEL = process.env.IMAGE_LABEL_MODEL || 'gpt-5.6-terra';
const MAX_BULK_IDS = 120;

// Read the shared image registry and the enrichment worker's run history.
class ImageLabelService extends BaseService {
    constructor(imageLabelModel, cronRunLogModel) {
        super();
        this.imageLabelModel = imageLabelModel;
        this.cronRunLogModel = cronRunLogModel;
    }

    /**
     * Labels for one warehouse's images, keyed by URL.
     *
     * Returns a map rather than groups so the caller stays authoritative about
     * which images exist and in what order — media is the source of truth, and
     * labels are decoration over it. Unlabelled images are simply absent from
     * the map, so a consumer can fall back per-image rather than all-or-nothing.
     *
     * @param {number|string} warehouseId
     * @returns {Promise<{warehouseId: number, total: number, labelled: number, labels: Object}>}
     */
    async getForWarehouse(warehouseId) {
        return this.executeOperation(async () => {
            const id = Number(warehouseId);
            if (!Number.isInteger(id) || id < 1) {
                const error = new Error('warehouseId must be a positive integer');
                error.name = 'ValidationError';
                error.issues = [{ path: ['id'], message: 'must be a positive integer' }];
                throw error;
            }

            const rows = await this.imageLabelModel.findForWarehouse(id);
            const labels = {};
            for (const r of rows) {
                if (!r.classification) continue;
                labels[r.imageUrl] = {
                    classification: r.classification,
                    description: r.description,
                    confidence: r.confidence,
                    documentKind: r.documentKind ?? null,
                };
            }
            return {
                warehouseId: id,
                total: rows.length,
                labelled: Object.keys(labels).length,
                labels,
                images: rows.map(r => serializeImage(r.imageUrl, r)),
            };
        });
    }

    /**
     * Labels for several warehouses, keyed by warehouseId then by image URL.
     *
     * Used by GET /api/warehouses?includeImageLabels=true to attach labels to a
     * page of rows in one query, so the client never needs a second request.
     * Capped so a caller cannot pull the whole table in one go.
     *
     * @param {Array<number|string>} warehouseIds
     * @returns {Promise<{requested: number, warehouses: Object}>}
     */
    async getForWarehouses(warehouseIds) {
        return this.executeOperation(async () => {
            const ids = [...new Set(
                (Array.isArray(warehouseIds) ? warehouseIds : [])
                    .map(Number)
                    .filter((n) => Number.isInteger(n) && n > 0),
            )];

            if (!ids.length) {
                const error = new Error('ids must contain at least one positive integer warehouse id');
                error.name = 'ValidationError';
                error.issues = [{ path: ['ids'], message: 'must contain at least one positive integer' }];
                throw error;
            }
            if (ids.length > MAX_BULK_IDS) {
                const error = new Error(`ids is limited to ${MAX_BULK_IDS} warehouses per request`);
                error.name = 'ValidationError';
                error.issues = [{ path: ['ids'], message: `at most ${MAX_BULK_IDS}` }];
                throw error;
            }

            const rows = await this.imageLabelModel.findForWarehouses(ids);
            const warehouses = {};
            for (const r of rows) {
                const key = String(r.warehouseId);
                if (!warehouses[key]) warehouses[key] = { total: 0, labelled: 0, labels: {}, images: [] };
                warehouses[key].total += 1;
                warehouses[key].images.push(serializeImage(r.imageUrl, r));
                if (!r.classification) continue;
                warehouses[key].labelled += 1;
                warehouses[key].labels[r.imageUrl] = {
                    classification: r.classification,
                    description: r.description,
                    confidence: r.confidence,
                    // Null unless the row is a DOCUMENT that has been sub-labelled.
                    // The picker uses it to pre-tick layout drawings; null there
                    // means "unknown", never "not a layout".
                    documentKind: r.documentKind ?? null,
                };
            }
            // Ids with no images at all still get an entry, so a caller can cache
            // "this one has nothing" instead of re-requesting it forever.
            for (const id of ids) {
                if (!warehouses[String(id)]) warehouses[String(id)] = { total: 0, labelled: 0, labels: {}, images: [] };
            }
            return { requested: ids.length, warehouses };
        });
    }

    /**
     * Current label coverage and recent sweep history.
     * @returns {Promise<Object>}
     */
    async getStats() {
        return this.executeOperation(async () => {
            const [labelled, remaining, byClassification, recentRuns] = await Promise.all([
                this.imageLabelModel.countAll(),
                this.imageLabelModel.countUnlabelled(),
                this.imageLabelModel.countByClassification(),
                this.cronRunLogModel.recent(JOB_NAME, 10),
            ]);
            return {
                labelled,
                remaining,
                byClassification,
                model: DEFAULT_MODEL,
                recentRuns: recentRuns.map((r) => ({
                    // id is a BigInt; JSON.stringify cannot serialize those.
                    id: String(r.id),
                    ranAt: r.ranAt,
                    status: r.status,
                    durationMs: r.durationMs,
                    metadata: r.metadata,
                    notes: r.notes,
                })),
            };
        });
    }
}

module.exports = ImageLabelService;
module.exports.JOB_NAME = JOB_NAME;
