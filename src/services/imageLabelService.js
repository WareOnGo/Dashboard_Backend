const { ImagePipelineRepository } = require('../models/imagePipelineRepository.cjs');
const { serializeImage } = require('../utils/imageContract.cjs');
const { invalidateImageCache } = require('../utils/imageCacheInvalidation');
// src/services/imageLabelService.js
const BaseService = require('./baseService');
const { PRICING, classify, classifyDocumentKind } = require('../utils/imageClassifier');
const { check } = require('../utils/enrichmentBudget');

/** Job name recorded in cron_run_log. */
const JOB_NAME = 'sweep_warehouse_image_labels';

/**
 * Model used for forward-fill labelling. gpt-5.6-terra was chosen after a
 * five-model comparison over a seeded 100-image sample; see
 * scripts/classifyWarehouseImagesSample.js. Overridable via env so the model can
 * be changed without a code deploy.
 */
const DEFAULT_MODEL = process.env.IMAGE_LABEL_MODEL || 'gpt-5.6-terra';

/**
 * Images processed per invocation. The sweep runs inside an HTTP request, so it
 * must finish well inside any proxy/App Runner timeout. At the measured ~4.7
 * images/sec this is roughly 30 seconds of work. A backlog larger than this is
 * not lost — it is simply picked up by the next poke, which is why the caller
 * gets `remaining` back in the response.
 */
const DEFAULT_LIMIT = 150;
const MAX_LIMIT = 500;

/** Parallel API requests within a sweep. */
const DEFAULT_CONCURRENCY = 8;

/**
 * Warehouses per bulk label lookup. Comfortably above the dashboard's largest
 * page size (100) so a full page is always one request, while still bounding
 * what a single caller can pull.
 */
const MAX_BULK_IDS = 120;

/**
 * A RUNNING row older than this is treated as abandoned, so a container that
 * died mid-sweep cannot wedge the job forever.
 */
const STALE_RUN_MS = 15 * 60 * 1000;

/**
 * Labeling owns scene labels/captions and document subtypes in the shared image
 * table. Each stage uses independent claims and retries.
 */
class ImageLabelService extends BaseService {
    constructor(imageLabelModel, cronRunLogModel) {
        super();
        this.imageLabelModel = imageLabelModel;
        this.cronRunLogModel = cronRunLogModel;
    }

    /**
     * Label up to `limit` unlabelled images.
     *
     * Skips (rather than queues) if another sweep is already in flight — two
     * containers labelling the same images is wasted spend, not a correctness
     * problem.
     *
     * @param {Object} [opts]
     * @param {number} [opts.limit] - Max images this invocation (capped at MAX_LIMIT)
     * @param {string} [opts.model] - Override the labelling model
     * @param {boolean} [opts.dryRun] - Report the backlog, call no APIs, write nothing
     * @returns {Promise<Object>} Summary of the run
     */
    async sweep({ limit = DEFAULT_LIMIT, model = DEFAULT_MODEL, dryRun = false, signal } = {}) {
        return this.executeOperation(async () => {
            const effectiveLimit = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), MAX_LIMIT);

            if (dryRun) {
                const [remaining, stale] = await Promise.all([
                    this.imageLabelModel.bounded('countUnlabelled'),
                    this.imageLabelModel.bounded('countStale'),
                ]);
                return {
                    status: 'DRY_RUN', model, limit: effectiveLimit,
                    processed: 0, labelled: 0, failed: 0,
                    // Historical response name; real runs mark retention rather than delete.
                    wouldPrune: stale,
                    remaining, durationMs: 0,
                };
            }

            if (!process.env.OPENAI_API_KEY) {
                // Fail loudly rather than silently labelling nothing forever.
                const error = new Error('OPENAI_API_KEY is not configured; image labelling is disabled.');
                error.name = 'ConfigurationError';
                throw error;
            }

            const run = await this.cronRunLogModel.tryStart(JOB_NAME, STALE_RUN_MS, { model, limit: effectiveLimit });
            if (!run) {
                return {
                    status: 'SKIPPED',
                    reason: 'another sweep is already running',
                    processed: 0, labelled: 0, failed: 0,
                };
            }

            const started = Date.now();

            try {
                const summary = await this.processBatch(effectiveLimit, model, signal);
                const unfinished = summary.remaining > 0 || Object.entries(summary.documentBacklog || {})
                    .some(([state, count]) => state !== 'READY' && count > 0);
                const status = summary.failed ? (summary.labelled || summary.documents ? 'PARTIAL' : 'FAILED')
                    : summary.deferred || unfinished ? 'PARTIAL' : 'SUCCESS';
                const durationMs = Date.now() - started;
                await this.cronRunLogModel.finish(
                    run.id,
                    status,
                    durationMs,
                    summary,
                    summary.failed ? `${summary.failed} image(s) failed; unfinished stages retain their retry state` : null,
                );
                return { status, model, limit: effectiveLimit, durationMs, ...summary };
            } catch (error) {
                await this.cronRunLogModel
                    .finish(run.id, 'FAILED', Date.now() - started, null, error.message)
                    // Never let bookkeeping failure mask the original error.
                    .catch(() => {});
                throw error;
            }
        });
    }

    /** Classify a batch using independent stage claims and retries. */
    async processBatch(limit, model, signal) {
        return this.processPipelineBatch(limit, model, signal);
    }

    // Stage-specific claims preserve successful scene labels during subtype retries.
    async processPipelineBatch(limit, model, signal) {
        const repository = new ImagePipelineRepository(this.imageLabelModel.prisma);
        check(signal);
        const { registered, retained } = await repository.reconcile();
        const summary = { processed: 0, labelled: 0, documents: 0, failed: 0, deferred: 0,
            registered, retained, pruned: 0, errors: [], costUsd: 0 };
        let inTok = 0, outTok = 0;
        try {
            for (const stage of ['label', 'document']) {
                let remainingBudget = limit;
                while (remainingBudget > 0 && !signal?.aborted) {
                    // Claim only work that can start immediately, so waiting in
                    // our own pool cannot consume another image's lease.
                    const rows = await repository.claim(stage, { limit: Math.min(DEFAULT_CONCURRENCY, remainingBudget) });
                    if (!rows.length) break;
                    remainingBudget -= rows.length;
                    await this.runPool(rows, async row => {
                        if (signal?.aborted) {
                            summary.deferred++;
                            await repository.fail(stage, row, '', { deferred: true });
                            return;
                        }
                        summary.processed++;
                        let result;
                        try {
                            result = await (stage === 'label' ? classify : classifyDocumentKind)(model, row.imageUrl, signal ? { signal } : {});
                        } catch { result = { error: 'Image classification failed' }; }
                        if (result.error || !(stage === 'label' ? result.classification : result.documentKind)) {
                            summary.failed++;
                            if (summary.errors.length < 20) summary.errors.push({ imageUrl: row.imageUrl, stage, error: 'Image classification failed' });
                            await repository.fail(stage, row, signal?.aborted ? 'Processing time budget exhausted' : 'Image classification failed');
                            return;
                        }
                        inTok += result.inputTokens || 0; outTok += result.outputTokens || 0;
                        const saved = await repository.complete(stage, row, { ...result, model });
                        summary[stage === 'label' ? 'labelled' : 'documents'] += saved;
                    }, DEFAULT_CONCURRENCY);
                }
            }
        } finally {
            if (summary.labelled || summary.documents) await invalidateImageCache();
        }
        const price = PRICING[model];
        summary.costUsd = price ? Number(((inTok * price.in + outTok * price.out) / 1e6).toFixed(4)) : null;
        summary.remaining = await this.imageLabelModel.countUnlabelled();
        summary.documentBacklog = await repository.backlog('document');
        return summary;
    }

    /**
     * Bounded-concurrency map. Workers pull from a shared cursor, so a slow image
     * doesn't stall the others.
     * @private
     */
    async runPool(items, worker, concurrency) {
        const out = new Array(items.length);
        let next = 0;
        await Promise.all(
            Array.from({ length: Math.min(concurrency, items.length) }, async () => {
                while (next < items.length) {
                    const i = next++;
                    out[i] = await worker(items[i], i);
                }
            }),
        );
        return out;
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
