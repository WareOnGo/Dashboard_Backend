const { CATEGORIES, METRIC_IDENTITY } = require('../utils/proximityCategories');
const { guardCandidates, resolve } = require('../utils/proximityShortlist');
const { fetchLegsFrom, TokenBucket, PROFILE, PROVIDER } = require('../utils/mapboxDirections');
const { check, sleep } = require('../utils/enrichmentBudget');
const WarehouseProximityModel = require('../models/warehouseProximityModel');

const sameCoordinates = (row, w) => row?.computedFromLat === w.lat && row?.computedFromLng === w.lng;

class WarehouseProximityService {
    constructor(model, runLog, { route = fetchLegsFrom } = {}) {
        this.model = model;
        this.runLog = runLog;
        this.route = route;
        this.bucket = new TokenBucket(120);
    }

    async sweep({ limit = 5, dryRun = false, signal } = {}) {
        const cap = Math.min(5, Math.max(1, Math.floor(Number(limit) || 5)));
        const expected = WarehouseProximityModel.expectedRegionsFor(CATEGORIES.map(c => c.key), 120, { hospital: 30 });
        check(signal);
        const coverage = await this.model.bounded('coverage', expected);
        const skippedCategories = coverage.filter(c => !c.complete).map(c => c.category);
        const categories = CATEGORIES.filter(c => !skippedCategories.includes(c.key));
        if (!categories.length) throw new Error('No proximity category has complete OSM coverage');
        check(signal);
        const todo = await this.model.bounded('findPending', categories, cap + 1);
        const result = {
            status: dryRun ? 'DRY_RUN' : 'SUCCESS', processed: 0, updated: 0, rows: 0,
            failed: 0, deferred: 0, hasMore: todo.length > cap, skippedCategories,
        };
        if (dryRun) return { ...result, eligibleSample: todo.length, limit: cap };
        if (!todo.length) return { ...result, status: skippedCategories.length ? 'PARTIAL' : 'SUCCESS' };
        if (!process.env.MAPBOX_ACCESS_TOKEN) throw new Error('MAPBOX_ACCESS_TOKEN is not configured');
        check(signal);
        const watermarks = await this.model.bounded('poiWatermarks');

        for (const warehouse of todo.slice(0, cap)) {
            if (signal?.aborted) { result.deferred++; continue; }
            const jobName = `warehouse_proximity:${warehouse.id}`;
            const prior = (await this.runLog.recent(jobName, 1))[0];
            check(signal);
            const previousAttempts = prior?.status === 'FAILED'
                && prior.metadata?.lat === warehouse.lat && prior.metadata?.lng === warehouse.lng
                ? Number(prior.metadata.attempts) || 0 : 0;
            const metadata = { lat: warehouse.lat, lng: warehouse.lng, attempts: previousAttempts + 1 };
            const run = await this.runLog.start(jobName, metadata);
            const started = Date.now();
            result.processed++;
            try {
                check(signal);
                const stored = await this.model.bounded('rowsFor', warehouse.id);
                // Current highway distances from OSRM, and terminal no-route/no-POI
                // answers, are all retained. Only missing/stale categories are routed.
                const needed = categories.filter(c => !sameCoordinates(stored.find(r => r.category === c.key), warehouse));
                const rows = await this.compute(warehouse, needed, watermarks, signal);
                check(signal);
                const written = rows.length ? await this.model.upsertCurrent(warehouse, rows) : 0;
                result.rows += written;
                if (written) result.updated++;
                await this.runLog.finish(run.id, 'SUCCESS', Date.now() - started, { ...metadata, rows: written });
            } catch (error) {
                result.failed++;
                // No proximity rows are fabricated for provider outages. Retry state
                // lives in the run log, separate from facts about the warehouse.
                const cooldown = Math.min(6 * 60, 15 * 2 ** Math.min(previousAttempts, 5));
                const retryAt = new Date(Date.now() + cooldown * 60000).toISOString();
                const reason = signal?.aborted ? 'Time budget exhausted'
                    : error.status ? `Routing unavailable (HTTP ${error.status})` : 'Proximity computation failed';
                await this.runLog.finish(run.id, 'FAILED', Date.now() - started, { ...metadata, retryAt }, reason);
                // A provider outage affects other warehouses too; stop paid requests
                // this run while allowing the independent image stage to finish.
                if (error.retryable || signal?.aborted) {
                    result.deferred += Math.min(todo.length, cap) - result.processed;
                    break;
                }
            }
        }
        result.status = result.failed ? (result.updated ? 'PARTIAL' : 'FAILED')
            : result.deferred || skippedCategories.length ? 'PARTIAL' : 'SUCCESS';
        return result;
    }

    async compute(warehouse, categories, watermarks, signal) {
        if (!categories.length) return [];
        check(signal);
        const poiCategories = categories.filter(c => c.metric !== METRIC_IDENTITY);
        const shortlists = new Map();
        const pois = await this.model.bounded('nearestPois', warehouse, poiCategories);
        for (const poi of pois) {
            if (!shortlists.has(poi.category)) shortlists.set(poi.category, []);
            shortlists.get(poi.category).push(poi);
        }
        for (const category of categories.filter(c => c.metric === METRIC_IDENTITY)) {
            check(signal);
            shortlists.set(category.key, await this.model.bounded('nearestHighway', warehouse, category.maxRadiusKm));
        }
        const entries = categories.map(category => ({ category,
            candidates: guardCandidates(shortlists.get(category.key) || []), legs: [] }));
        const jobs = entries.flatMap(entry => entry.category.metric === METRIC_IDENTITY ? []
            : entry.candidates.map(candidate => ({ entry, candidate })));
        const legs = await this.route(process.env.MAPBOX_ACCESS_TOKEN, warehouse,
            jobs.map(j => ({ lat: j.candidate.lat, lng: j.candidate.lng })), {
                signal, timeoutMs: 8000, retryDelaysMs: [], chunkConcurrency: 1, requireValidResponse: true,
                onRequest: async () => {
                    check(signal);
                    await this.bucket.take(ms => sleep(ms, signal));
                    check(signal);
                },
            });
        jobs.forEach((job, i) => job.entry.legs.push(legs[i]));
        return entries.map(({ category, candidates, legs: routes }) => ({
            category: category.key, ...resolve({ category, candidates, legs: routes }),
            provider: category.metric === METRIC_IDENTITY ? null : PROVIDER,
            profile: category.metric === METRIC_IDENTITY ? null : PROFILE,
            computedFromLat: warehouse.lat, computedFromLng: warehouse.lng,
            poiWatermark: watermarks.get(category.key) || null,
        }));
    }
}

module.exports = WarehouseProximityService;
