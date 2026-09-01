/**
 * Backfill warehouse_proximity: the nearest landmark of each category for every
 * warehouse that has coordinates.
 *
 * Replaces work the `detailed` PPT deck currently does LIVE, per warehouse, per
 * export, against Overpass and Nominatim — uncached beyond five minutes in process,
 * persisting nothing, and swallowing failures to "N/A". Once this table is
 * populated the decks read it as ordinary columns and make no network call at all.
 *
 * WHAT IT WILL AND WILL NOT CLAIM. Ten categories get a real road distance and
 * drive time from Mapbox Directions. Highways get a NAME ONLY. That is a
 * correctness decision: 95.5% of India's numbered-highway mileage is `trunk` or
 * `primary`, i.e. not access-controlled, so vehicles join it at ordinary crossroads
 * that OSM has no reason to mark. "Nearest highway: NH-48" is supportable;
 * distance-to-carriageway describes a road you often cannot join there, and
 * distance-to-ramp exists only for the other 4.5%. See src/utils/proximityCategories.js.
 *
 * IT REFUSES TO USE INCOMPLETE SOURCE DATA. The POI ingest records one row per
 * (region, category) in osm_ingest_tile, including regions that returned empty, so
 * partial coverage is detectable rather than silent. A category fetched for only
 * part of the country would otherwise yield a confident "nearest hospital is 180 km
 * away" for every warehouse in a region never fetched — an artefact of our own
 * ingest, presented as a fact about the site. Such a category is skipped and named.
 *
 * Resumable: a warehouse already holding a row for every selected category is
 * skipped, so re-running costs only what is missing. Interrupting is safe.
 *
 * Usage:
 *   node -r dotenv/config scripts/backfillWarehouseProximity.js [flags]
 *     --ids=995,1065        only these warehouse ids
 *     --limit=50            stop after this many warehouses
 *     --only=hospital,fuel  restrict to these categories
 *     --rate=200            Mapbox requests per minute (ceiling is ~300)
 *     --concurrency=8       parallel routing calls, within the rate limit
 *     --recompute           redo warehouses that already have rows
 *     --skip-coverage-check trust partial POI data (you almost never want this)
 *     --dry-run             shortlist and print, make no paid calls, write nothing
 *     --verify              print the census and exit
 *
 * Recovering from a failure:
 *   - killed / crashed / Ctrl-C -> re-run the same command; completed warehouses
 *     are skipped.
 *   - a landmark that never routes -> stored as ROUTING_FAILED with an attempt
 *     count, so it stops being retried indefinitely.
 */
const { PrismaClient } = require('@prisma/client');
const WarehouseProximityModel = require('../src/models/warehouseProximityModel');
const {
    CATEGORIES, METRIC_IDENTITY, proximityCategoryFor, proximityKeys,
} = require('../src/utils/proximityCategories');
const { guardCandidates, resolve, STATUS } = require('../src/utils/proximityShortlist');
const {
    fetchLegsFrom, TokenBucket, PROFILE, PROVIDER, DirectionsUnavailableError,
} = require('../src/utils/mapboxDirections');
const { categoryFor } = require('../src/utils/osmCategories');

const prisma = new PrismaClient();
const model = new WarehouseProximityModel(prisma);

const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);
const list = (raw) => (raw || '').split(',').map((s) => s.trim()).filter(Boolean);

const IDS = list(arg('ids', '')).map(Number).filter(Number.isFinite);
const LIMIT = Number(arg('limit', 0)) || null;
const ONLY = list(arg('only', ''));
const RATE = Number(arg('rate', 200));
const CONCURRENCY = Number(arg('concurrency', 8));
const RECOMPUTE = has('recompute');
const SKIP_COVERAGE = has('skip-coverage-check');
const DRY_RUN = has('dry-run');
const VERIFY_ONLY = has('verify');

/** Regions each ingest category needs before it counts as nationally complete. */
const FOOTPRINT_TILES = 120;
const GRID_CELLS = { hospital: 30 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bucket = new TokenBucket(RATE);

let stopping = false;
process.on('SIGINT', () => {
    if (stopping) { console.error('\nSecond interrupt — exiting now.'); process.exit(130); }
    stopping = true;
    console.error('\nInterrupt received. Finishing the warehouse in flight, then stopping...');
});

/** The pooler drops connections; losing a write means re-spending on routing. */
async function withRetry(label, fn, attempts = 8) {
    for (let i = 0; ; i++) {
        try { return await fn(); } catch (err) {
            if (i >= attempts - 1) throw err;
            const wait = Math.min(2 ** i, 15);
            console.warn(`  ! ${label} failed (attempt ${i + 1}/${attempts}), retrying in ${wait}s`);
            await sleep(wait * 1000);
        }
    }
}

/** Fixed-size pool, preserving input order. */
async function runPool(items, worker, concurrency) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) },
        async () => {
            for (;;) {
                const i = next++;
                if (i >= items.length) return;
                out[i] = await worker(items[i], i);
            }
        }));
    return out;
}

async function main() {
    if (VERIFY_ONLY) return verify();

    const selected = CATEGORIES.filter((c) => !ONLY.length || ONLY.includes(c.key));
    if (!selected.length) {
        console.error(`No categories matched --only. Known: ${proximityKeys().join(', ')}`);
        process.exit(1);
    }

    // --- refuse partial source data ------------------------------------------
    // Every startup query goes through withRetry, same as the ones in the main
    // loop. Without it a transient pooler blip on the FIRST call killed the whole
    // run — which is exactly backwards, since the run is otherwise built to survive
    // the pooler dropping connections. Observed in practice: a Supabase outage took
    // the process down at the coverage check and both passes exited immediately.
    const expected = WarehouseProximityModel.expectedRegionsFor(
        selected.map((c) => c.key), FOOTPRINT_TILES, GRID_CELLS,
    );
    const coverage = await withRetry('coverage check', () => model.coverage(expected));
    const incomplete = coverage.filter((c) => !c.complete);
    let usable = selected;
    if (incomplete.length) {
        console.log('\n=== source data coverage ===');
        incomplete.forEach((c) => console.log(
            `  ${c.category.padEnd(18)} ${c.done}/${c.expected} regions ingested  INCOMPLETE`));
        if (SKIP_COVERAGE) {
            console.warn('  --skip-coverage-check given: computing against partial data anyway.');
        } else {
            usable = selected.filter((c) => !incomplete.some((i) => i.category === c.key));
            console.log(`  Skipping ${incomplete.length} category(ies). Finish the ingest, then re-run —`);
            console.log('  a category covering only part of the country produces confident wrong');
            console.log('  answers for every warehouse in a region that was never fetched.');
        }
    }
    if (!usable.length) {
        console.error('\nNo category has complete source data. Run the POI ingest first.');
        process.exit(1);
    }

    const token = process.env.MAPBOX_ACCESS_TOKEN;
    const needsRouting = usable.some((c) => c.metric !== METRIC_IDENTITY);
    if (!DRY_RUN && needsRouting && !token) {
        console.error('MAPBOX_ACCESS_TOKEN is not set. Add it to .env and re-run with -r dotenv/config');
        process.exit(1);
    }

    let warehouses = await withRetry('load warehouses',
        () => model.warehousesToCompute({ ids: IDS.length ? IDS : null, limit: null }));
    const total = warehouses.length;
    if (!RECOMPUTE) {
        const done = await withRetry('load completed set',
            () => model.alreadyComputed(usable.map((c) => c.key)));
        warehouses = warehouses.filter((w) => !done.has(w.id));
    }
    if (LIMIT) warehouses = warehouses.slice(0, LIMIT);

    const watermarks = await withRetry('load POI watermarks', () => model.poiWatermarks());
    const legsPerWarehouse = usable
        .filter((c) => c.metric !== METRIC_IDENTITY)
        .reduce((s, c) => s + c.candidates, 0);

    console.log('\n=== plan ===');
    console.log(`  categories        ${usable.map((c) => c.key).join(', ')}`);
    console.log(`  warehouses        ${warehouses.length} to compute (${total} have coordinates)`);
    console.log(`  routing legs      up to ${legsPerWarehouse} each, ~${legsPerWarehouse * warehouses.length} total`);
    console.log(`                    batched ~12 per billed request, so ~`
        + `${Math.ceil(legsPerWarehouse / 12) * warehouses.length} requests`);
    console.log(`  rate              ${RATE}/min, concurrency ${CONCURRENCY}`);
    if (!warehouses.length) { console.log('\nNothing to do.'); return verify(); }

    if (DRY_RUN) {
        const w = warehouses[0];
        console.log(`\n[dry-run] shortlist for warehouse ${w.id} (${w.lat.toFixed(4)},${w.lng.toFixed(4)}):\n`);
        const rows = await shortlistFor(w, usable);
        for (const c of usable) {
            const cands = rows.get(c.key) || [];
            const head = cands[0];
            console.log(`  ${c.key.padEnd(18)} ${cands.length} candidate(s)`
                + (head ? `  nearest: ${String(head.name || '(unnamed)').slice(0, 30)} `
                    + `at ${(head.directM / 1000).toFixed(1)} km` : `  none within ${c.maxRadiusKm} km`));
        }
        console.log('\n[dry-run] no paid calls were made and nothing was written.');
        return;
    }

    const startedAt = Date.now();
    const totals = { warehouses: 0, rows: 0, legs: 0, requests: 0, unavailable: 0, byStatus: {} };

    for (const w of warehouses) {
        if (stopping) break;

        let rows;
        try {
            rows = await computeWarehouse(w, usable, token, watermarks, totals);
        } catch (err) {
            // Routing was unavailable, not unsuccessful. Writing anything here would
            // persist "not reachable" as a fact about the site when the truth is that
            // we were throttled. Leave the warehouse uncomputed so a later run — or
            // the next few seconds — retries it honestly.
            totals.unavailable++;
            if (err instanceof DirectionsUnavailableError) {
                console.error(`  ~ warehouse ${w.id}: routing unavailable`
                    + `${err.status ? ` (HTTP ${err.status})` : ''} — left uncomputed for a later run`);
                // Back off before the next warehouse rather than marching through the
                // whole list against a service that is refusing us.
                await sleep(5000);
                continue;
            }
            console.error(`  x warehouse ${w.id}: ${err.message.slice(0, 100)}`);
            continue;
        }

        try {
            await withRetry(`write warehouse ${w.id}`, () => model.upsertMany(w.id, rows));
            totals.rows += rows.length;
            totals.warehouses++;
        } catch (err) {
            console.error(`  x warehouse ${w.id}: write failed — ${err.message.slice(0, 90)}`);
        }

        if (totals.warehouses % 10 === 0 || totals.warehouses === warehouses.length) {
            const elapsed = (Date.now() - startedAt) / 1000;
            const pct = Math.round((totals.warehouses / warehouses.length) * 100);
            const eta = Math.round((elapsed / Math.max(1, totals.warehouses))
                * (warehouses.length - totals.warehouses));
            console.log(`  ${String(pct).padStart(3)}%  ${totals.warehouses}/${warehouses.length}  `
                + `rows ${totals.rows}  legs ${totals.legs} in ${totals.requests} req  `
                + `${elapsed.toFixed(0)}s elapsed, eta ${eta}s`);
        }
    }

    if (stopping) console.log('\nStopped early. Re-run the same command to continue.');

    console.log('\n=== totals ===');
    console.log(`  warehouses ${totals.warehouses}  rows ${totals.rows}  `
        + `routing legs ${totals.legs} in ${totals.requests} billed request(s)`);
    if (totals.unavailable) {
        console.log(`  ${totals.unavailable} warehouse(s) left uncomputed because routing was `
            + 'unavailable — re-run to pick them up');
    }
    Object.entries(totals.byStatus).forEach(([k, v]) => console.log(`  ${k.padEnd(16)} ${v}`));

    await verify();
}

/** Shortlist every category for one warehouse. @returns {Map<string, Array>} */
async function shortlistFor(warehouse, categories) {
    const at = { lat: warehouse.lat, lng: warehouse.lng };
    const poiCats = categories.filter((c) => {
        const ingest = categoryFor(c.key);
        return ingest && ingest.target !== WarehouseProximityModel.TARGET_HIGHWAY;
    });
    const hwCats = categories.filter((c) => !poiCats.includes(c));

    const out = new Map();
    if (poiCats.length) {
        const rows = await withRetry('shortlist', () => model.nearestPois(at, poiCats));
        rows.forEach((r) => {
            if (!out.has(r.category)) out.set(r.category, []);
            out.get(r.category).push(r);
        });
    }
    for (const c of hwCats) {
        const rows = await withRetry('nearest highway', () => model.nearestHighway(at, c.maxRadiusKm));
        out.set(c.key, rows);
    }
    return out;
}

/**
 * Compute all category rows for one warehouse.
 *
 * Every leg across every category is routed in ONE pool rather than a pool per
 * category. The distinction is not cosmetic: routing per category serialises ten
 * small batches behind each other, and since each batch is bounded by the rate
 * limiter rather than by concurrency, the warehouse ends up waiting ten times for
 * work that could have overlapped. Measured on the first run at 14s per warehouse,
 * against ~19 legs that at 200/min should cost under 6s.
 */
async function computeWarehouse(warehouse, categories, token, watermarks, totals) {
    const shortlists = await shortlistFor(warehouse, categories);
    const at = { lat: warehouse.lat, lng: warehouse.lng };

    // Shortlist every category first, then flatten the legs into a single queue.
    const entries = categories.map((category) => ({
        category,
        candidates: guardCandidates(shortlists.get(category.key) || []),
        legs: [],
    }));

    const jobs = [];
    entries.forEach((entry, entryIndex) => {
        if (entry.category.metric === METRIC_IDENTITY) return;
        entry.candidates.forEach((c, slot) => jobs.push({ entryIndex, slot, c }));
    });

    // Every destination across every category goes into one call, which Mapbox
    // answers 12 at a time as a single billed request each. Verified against
    // separate per-leg calls: identical to 0.000 km. This is what took the backfill
    // from ~17 requests per warehouse to ~2, and since the job is bounded by the
    // rate limit rather than by concurrency, it is the same factor off the clock.
    const results = await fetchLegsFrom(token, at, jobs.map((j) => ({ lat: j.c.lat, lng: j.c.lng })), {
        overview: 'false',
        onRequest: async () => { await bucket.take(sleep); totals.requests++; },
    });
    totals.legs += jobs.length;

    // Scatter the flat results back to the category they belong to.
    jobs.forEach((job, i) => { entries[job.entryIndex].legs[job.slot] = results[i]; });

    const rows = [];
    for (const { category, candidates, legs } of entries) {
        const resolved = resolve({ category, candidates, legs });
        totals.byStatus[resolved.status] = (totals.byStatus[resolved.status] || 0) + 1;
        rows.push({
            category: category.key,
            ...resolved,
            provider: resolved.status === STATUS.OK ? PROVIDER : null,
            profile: resolved.status === STATUS.OK ? PROFILE : null,
            computedFromLat: warehouse.lat,
            computedFromLng: warehouse.lng,
            poiWatermark: watermarks.get(category.key) || null,
        });
    }
    return rows;
}

/** Census plus the sanity checks worth failing on. */
async function verify() {
    console.log('\n=== verification ===');
    const census = await model.census();
    if (!census.length) { console.log('  no rows yet'); return; }

    const enrichable = Number((await prisma.$queryRawUnsafe(
        'SELECT count(*)::int n FROM "WarehouseData" WHERE geog IS NOT NULL'))[0].n);
    const allWh = Number((await prisma.$queryRawUnsafe(
        'SELECT count(*)::int n FROM "Warehouse"'))[0].n);
    const computed = Number((await prisma.$queryRawUnsafe(
        'SELECT count(DISTINCT "warehouseId")::int n FROM warehouse_proximity'))[0].n);

    console.log(`  coverage: ${computed} of ${enrichable} warehouses with coordinates `
        + `(${allWh} total; the rest have no coordinates and are a geocoding problem, not this one)`);
    console.log('\n  category            status            rows   avg km');
    census.forEach((r) => console.log(`  ${r.category.padEnd(18)}  ${r.status.padEnd(16)}`
        + `${String(r.n).padStart(5)}   ${r.avg_km === null ? '-' : r.avg_km}`));

    // A row that claims OK must carry the numbers that status promises.
    const broken = Number((await prisma.$queryRawUnsafe(
        `SELECT count(*)::int n FROM warehouse_proximity
          WHERE status = 'OK' AND ("roadKm" IS NULL OR "driveMinutes" IS NULL)`))[0].n);
    if (broken) {
        console.error(`  FAIL: ${broken} row(s) marked OK with no distance`);
        process.exitCode = 1;
    }
    const zero = Number((await prisma.$queryRawUnsafe(
        `SELECT count(*)::int n FROM warehouse_proximity WHERE "roadKm" = 0`))[0].n);
    if (zero) console.warn(`  WARN: ${zero} row(s) have roadKm = 0 — a landmark on top of the warehouse?`);

    const flagged = await prisma.$queryRawUnsafe(
        `SELECT unnest(warnings) AS w, count(*)::int n FROM warehouse_proximity
          GROUP BY 1 ORDER BY n DESC`);
    if (flagged.length) {
        console.log('\n  warnings raised:');
        flagged.forEach((f) => console.log(`    ${f.w.padEnd(26)} ${f.n}`));
    }
}

module.exports = { computeWarehouse, shortlistFor };

if (require.main === module) {
    main()
        .catch((err) => { console.error('ERR:', err && err.message); process.exit(1); })
        .finally(() => prisma.$disconnect());
}
