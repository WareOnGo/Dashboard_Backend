// src/services/imageLabelService.js
const BaseService = require('./baseService');
const { PRICING, classify } = require('../utils/imageClassifier');

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

/** Rows per database write. Chunked so a mid-sweep failure keeps earlier work. */
const CHUNK = 50;

/**
 * A RUNNING row older than this is treated as abandoned, so a container that
 * died mid-sweep cannot wedge the job forever.
 */
const STALE_RUN_MS = 15 * 60 * 1000;

/**
 * ImageLabelService — forward-fill classification of warehouse listing images.
 *
 * Deliberately a sweep rather than a hook on each submit path. The three submit
 * routes (dashboard, scout, partner ingest) all converge on
 * StagingService.approveSubmission, but PUT /api/warehouses/:id writes straight
 * to the master table and bypasses staging entirely, so a promotion-time hook
 * would silently miss edited listings. Asking "what is unlabelled?" covers every
 * writer, past and future, and self-heals transient API failures on the next run
 * with no dead-letter handling.
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
    async sweep({ limit = DEFAULT_LIMIT, model = DEFAULT_MODEL, dryRun = false } = {}) {
        return this.executeOperation(async () => {
            const effectiveLimit = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), MAX_LIMIT);

            if (dryRun) {
                const [remaining, stale] = await Promise.all([
                    this.imageLabelModel.countUnlabelled(),
                    this.imageLabelModel.countStale(),
                ]);
                return {
                    status: 'DRY_RUN', model, limit: effectiveLimit,
                    processed: 0, labelled: 0, failed: 0,
                    // What a real run would prune, without deleting anything.
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

            const inFlight = await this.cronRunLogModel.findInFlight(JOB_NAME, STALE_RUN_MS);
            if (inFlight) {
                return {
                    status: 'SKIPPED',
                    reason: 'another sweep is already running',
                    startedAt: inFlight.ranAt,
                    processed: 0, labelled: 0, failed: 0,
                };
            }

            const run = await this.cronRunLogModel.start(JOB_NAME, { model, limit: effectiveLimit });
            const started = Date.now();

            try {
                const summary = await this.processBatch(effectiveLimit, model);
                const durationMs = Date.now() - started;
                await this.cronRunLogModel.finish(
                    run.id,
                    summary.failed && !summary.labelled ? 'FAILED' : 'SUCCESS',
                    durationMs,
                    summary,
                    summary.failed ? `${summary.failed} image(s) failed; they stay unlabelled and retry next sweep` : null,
                );
                return { status: 'SUCCESS', model, limit: effectiveLimit, durationMs, ...summary };
            } catch (error) {
                await this.cronRunLogModel
                    .finish(run.id, 'FAILED', Date.now() - started, null, error.message)
                    // Never let bookkeeping failure mask the original error.
                    .catch(() => {});
                throw error;
            }
        });
    }

    /**
     * Classify one batch and persist it in chunks.
     *
     * Failed images are deliberately not written, so they reappear in the next
     * sweep's findUnlabelled() and get retried — that is the whole retry
     * mechanism, and why no dead-letter table is needed.
     * @private
     */
    async processBatch(limit, model) {
        // Prune first, so a stale row can never block a URL that is still in use
        // from being re-labelled in this same run.
        const pruned = await this.imageLabelModel.pruneStale();

        const todo = await this.imageLabelModel.findUnlabelled(limit);
        if (!todo.length) {
            return { processed: 0, labelled: 0, failed: 0, pruned, remaining: 0, costUsd: 0, errors: [] };
        }

        let labelled = 0, failed = 0, inTok = 0, outTok = 0;
        const errors = [];

        for (let offset = 0; offset < todo.length; offset += CHUNK) {
            const batch = todo.slice(offset, offset + CHUNK);
            const results = await this.runPool(
                batch,
                (row) => classify(model, row.imageUrl),
                DEFAULT_CONCURRENCY,
            );

            const rows = [];
            results.forEach((res, i) => {
                if (res.error) {
                    failed++;
                    if (errors.length < 20) errors.push({ imageUrl: batch[i].imageUrl, error: res.error });
                    return;
                }
                inTok += res.inputTokens;
                outTok += res.outputTokens;
                rows.push({
                    warehouseId: batch[i].warehouseId,
                    imageUrl: batch[i].imageUrl,
                    classification: res.classification,
                    description: res.description,
                    model,
                    confidence: res.confidence,
                });
            });

            if (rows.length) labelled += await this.imageLabelModel.createManyLabels(rows);
        }

        const price = PRICING[model];
        const costUsd = price ? (inTok / 1e6) * price.in + (outTok / 1e6) * price.out : null;

        return {
            processed: todo.length,
            labelled,
            failed,
            pruned,
            remaining: await this.imageLabelModel.countUnlabelled(),
            costUsd: costUsd === null ? null : Number(costUsd.toFixed(4)),
            errors,
        };
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
                };
            }
            return {
                warehouseId: id,
                total: rows.length,
                labelled: Object.keys(labels).length,
                labels,
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
                if (!warehouses[key]) warehouses[key] = { total: 0, labelled: 0, labels: {} };
                warehouses[key].total += 1;
                if (!r.classification) continue;
                warehouses[key].labelled += 1;
                warehouses[key].labels[r.imageUrl] = {
                    classification: r.classification,
                    description: r.description,
                    confidence: r.confidence,
                };
            }
            // Ids with no images at all still get an entry, so a caller can cache
            // "this one has nothing" instead of re-requesting it forever.
            for (const id of ids) {
                if (!warehouses[String(id)]) warehouses[String(id)] = { total: 0, labelled: 0, labels: {} };
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
