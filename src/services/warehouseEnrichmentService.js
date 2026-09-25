const { createBudget } = require('../utils/enrichmentBudget');

const JOB_NAME = 'sweep_warehouse_enrichment';

class WarehouseEnrichmentService {
    constructor(imageLabels, proximity, runLog, websiteImages) {
        this.imageLabels = imageLabels;
        this.proximity = proximity;
        this.runLog = runLog;
        this.websiteImages = websiteImages;
    }

    async sweep({ dryRun = false } = {}) {
        const started = Date.now();
        const workDeadline = started + 80000;
        const run = dryRun ? null : await this.runLog.tryStart(JOB_NAME, 15 * 60000);
        if (!dryRun && !run) return { status: 'SKIPPED', reason: 'Another enrichment sweep is running' };
        const stages = {};
        // Scene labels remain a separate model action. The two independent
        // follow-up stages share the remaining wall-clock budget, not row locks.
        const runStage = async (name, service, duration, limit) => {
            const remainingMs = Math.min(duration, workDeadline - Date.now());
            if (remainingMs <= 0) {
                stages[name] = { status: 'PARTIAL', deferred: true, reason: 'Enrichment time budget exhausted' };
                return;
            }
            const budget = createBudget(remainingMs);
            try {
                stages[name] = await service.sweep({ dryRun, signal: budget.signal, limit });
            } catch (error) {
                stages[name] = { status: 'FAILED', error: `${name} enrichment failed`,
                    configurationMissing: /is not configured/.test(error.message) };
                console.error(`Warehouse enrichment ${name} failed (${error.name || 'Error'})`);
            } finally {
                budget.close();
            }
        };
        await runStage('images', this.imageLabels, 30000, 50);
        await Promise.all([
            runStage('proximity', this.proximity, 45000, 5),
            runStage('websiteImages', this.websiteImages, 45000, 12),
        ]);
        const failures = Object.values(stages).filter(s => ['FAILED', 'PARTIAL'].includes(s.status));
        const status = failures.length ? (failures.length === Object.keys(stages).length && failures.every(s => s.status === 'FAILED')
            ? 'FAILED' : 'PARTIAL') : dryRun ? 'DRY_RUN' : 'SUCCESS';
        const result = { status, durationMs: Date.now() - started, stages,
            ...(dryRun ? { configured: { images: Boolean(process.env.OPENAI_API_KEY),
                websiteImages: Boolean(process.env.OPENAI_API_KEY),
                proximity: Boolean(process.env.MAPBOX_ACCESS_TOKEN) } } : {}) };
        if (run) await this.runLog.finish(run.id, status, result.durationMs, stages);
        return result;
    }
}

module.exports = WarehouseEnrichmentService;
