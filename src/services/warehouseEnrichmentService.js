const { createBudget } = require('../utils/enrichmentBudget');

const JOB_NAME = 'sweep_warehouse_enrichment';

class WarehouseEnrichmentService {
    constructor(imageLabels, proximity, runLog) {
        this.imageLabels = imageLabels;
        this.proximity = proximity;
        this.runLog = runLog;
    }

    async sweep({ dryRun = false } = {}) {
        const started = Date.now();
        const workDeadline = started + 80000;
        const run = dryRun ? null : await this.runLog.tryStart(JOB_NAME, 15 * 60000);
        if (!dryRun && !run) return { status: 'SKIPPED', reason: 'Another enrichment sweep is running' };
        const stages = {};
        // Sequential work keeps peak load down. Each stage can fail or find no
        // work independently. Deadlines abort API calls, not just the HTTP waiter.
        for (const [name, service, duration, limit] of [
            ['images', this.imageLabels, 30000, 50],
            ['proximity', this.proximity, 45000, 5],
        ]) {
            const remainingMs = Math.min(duration, workDeadline - Date.now());
            if (remainingMs <= 0) {
                stages[name] = { status: 'PARTIAL', deferred: true, reason: 'Enrichment time budget exhausted' };
                continue;
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
        }
        const failures = Object.values(stages).filter(s => ['FAILED', 'PARTIAL'].includes(s.status));
        const status = failures.length ? (failures.length === 2 && failures.every(s => s.status === 'FAILED')
            ? 'FAILED' : 'PARTIAL') : dryRun ? 'DRY_RUN' : 'SUCCESS';
        const result = { status, durationMs: Date.now() - started, stages,
            ...(dryRun ? { configured: { images: Boolean(process.env.OPENAI_API_KEY),
                proximity: Boolean(process.env.MAPBOX_ACCESS_TOKEN) } } : {}) };
        if (run) await this.runLog.finish(run.id, status, result.durationMs, stages);
        return result;
    }
}

module.exports = WarehouseEnrichmentService;
