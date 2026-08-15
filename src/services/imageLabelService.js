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
