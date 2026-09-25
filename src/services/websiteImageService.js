const { assessWebsiteImage, MODEL, VERSION } = require('../utils/websiteImageAssessment.cjs');
const { invalidateImageCache } = require('../utils/imageCacheInvalidation');
const { retryDatabase } = require('../utils/websiteImageDatabase.cjs');
const JOB_NAME = 'sweep_warehouse_website_images';

class WebsiteImageService {
    constructor(repository, runLog, { assess = assessWebsiteImage } = {}) {
        this.repository = repository; this.runLog = runLog; this.assess = assess;
    }
    async sweep({ dryRun = false, signal, limit = 12 } = {}) {
        if (dryRun) return { status: 'DRY_RUN', model: MODEL, version: VERSION,
            backlog: await this.repository.backlog('website'), limit };
        if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
        const run = await this.runLog.tryStart(JOB_NAME, 15 * 60000, { model: MODEL, version: VERSION });
        if (!run) return { status: 'SKIPPED', reason: 'Another website assessment sweep is running' };
        const started = Date.now();
        try {
            const summary = await this.processBatch({ limit, signal });
            summary.backlog = await this.repository.backlog('website');
            const status = summary.failed ? (summary.assessed ? 'PARTIAL' : 'FAILED') : summary.deferred ? 'PARTIAL' : 'SUCCESS';
            const result = { status, model: MODEL, version: VERSION, durationMs: Date.now() - started, ...summary };
            await this.runLog.finish(run.id, status, result.durationMs, summary);
            return result;
        } catch (error) {
            await this.runLog.finish(run.id, 'FAILED', Date.now() - started, null, 'Website image assessment failed').catch(() => {});
            throw error;
        }
    }
    async processBatch({ limit = 12, concurrency = 4, allEntries = false, signal, onResult = async () => {} } = {}) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100000 || !Number.isInteger(concurrency)
            || concurrency < 1 || concurrency > 16) throw new Error('Invalid website image batch limits');
        const summary = { processed: 0, assessed: 0, failed: 0, unsupported: 0, deferred: 0, stale: 0,
            decisions: { ALLOW: 0, BLOCK: 0, REVIEW: 0 }, inputTokens: 0, outputTokens: 0 };
        const controller = new AbortController();
        const workingSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        let fatalError;
        let tickets = 0;
        await Promise.all(Array.from({ length: Math.min(concurrency, limit) }, async () => {
          try {
            while (!workingSignal.aborted && tickets < limit) {
                tickets++;
                const [row] = await retryDatabase(() => this.repository.claim('website', { limit: 1, allEntries }), { signal: workingSignal });
                if (!row) break;
                if (workingSignal.aborted) {
                    await retryDatabase(() => this.repository.fail('website', row, '', { deferred: true }), { signal: workingSignal }); summary.deferred++; break;
                }
                summary.processed++;
                let result;
                try { result = await this.assess(row.imageUrl, { signal: workingSignal }); }
                catch (error) {
                    // Paid work that times out counts as an attempt. Only claims
                    // that never started above are released without an attempt.
                    const reason = typeof error.code === 'string' ? error.code : 'website_assessment_failed';
                    await retryDatabase(() => this.repository.fail('website', row, reason,
                        { deferred: false, unsupported: Boolean(error.unsupported) }), { signal: workingSignal });
                    summary.failed++; if (error.unsupported) summary.unsupported++;
                    await onResult({ id: row.id, outcome: error.unsupported ? 'UNSUPPORTED' : 'FAILED', reason }, { ...summary });
                    if (/^model_http_(401|403|404)$/.test(error.code || '')) throw new Error('Website model configuration rejected');
                    continue;
                }
                const saved = await retryDatabase(() => this.repository.complete('website', row, result), { signal: workingSignal });
                summary.assessed += saved;
                if (saved) summary.decisions[result.decision]++;
                else summary.stale++;
                summary.inputTokens += result.usage?.inputTokens || 0;
                summary.outputTokens += result.usage?.outputTokens || 0;
                await onResult({ id: row.id, outcome: saved ? 'READY' : 'STALE', decision: result.decision,
                    qualityTier: result.qualityTier, usage: result.usage }, { ...summary });
            }
          } catch (error) { fatalError ||= error; controller.abort(); }
        }));
        if (fatalError) throw fatalError;
        if (summary.assessed && !allEntries) await invalidateImageCache();
        return summary;
    }
}
module.exports = WebsiteImageService;
