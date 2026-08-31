/**
 * Import points of interest from OpenStreetMap into osm_poi and osm_highway.
 *
 * The table this fills has existed, fully modelled, with a generated geography and
 * a GiST index, since the geo work landed — and it has been holding 300 rows in
 * two categories because the importer its schema comment pointed at was never
 * written. This is that importer.
 *
 * WHY OVERPASS AND NOT A PLANET EXTRACT. The schema comment describes osm_poi as
 * "reproducible from a public extract", which implies a .osm.pbf import. Overpass
 * is used instead because it needs no new dependency and no 1.5 GB download to
 * answer eleven narrow questions, and its data is current rather than as fresh as
 * the last extract. The cost is that Overpass is a donated shared service that
 * sheds load, which is why so much of this file is about retries and about
 * recording what did not come back.
 *
 * WHY MOST CATEGORIES ARE ONE NATIONAL REQUEST. Measuring the national counts
 * before writing this showed ten of the eleven categories fit in a single request
 * each — 69 MB of JSON in total. A national fetch also has no edge: a grid tiled
 * around our own warehouses would silently bound "nearest fire station" by where
 * we happen to own listings today. The two highway categories are the exception,
 * measured at 2.6 MB per square degree, so full national geometry would be ~2.6 GB
 * and they stay restricted to a buffer around our warehouses. See
 * src/utils/osmCategories.js.
 *
 * WHAT THIS SUPERSEDES. src/ppt/services/geospatialService.js calls Overpass and
 * Nominatim live, per warehouse, per PPT export, for three of these categories,
 * caching for five minutes in process and persisting nothing. Retiring that is a
 * separate change and deliberately not done here — see the plan.
 *
 * Resumable by design: every (region, category) fetch is recorded in
 * osm_ingest_tile, so re-running costs only what has not succeeded yet. Editing a
 * category's query changes its hash, which marks its records stale and refetches
 * just that category.
 *
 * Usage:
 *   node -r dotenv/config scripts/importOsmPois.js [flags]
 *     --only=fuel,hospital     restrict to these categories
 *     --tile-deg=0.5           footprint tile size, for the highway categories
 *     --refetch                refetch regions already ok/empty
 *     --max-age=30d            treat records older than this as stale
 *     --endpoint=<url>         Overpass endpoint (or OVERPASS_ENDPOINT)
 *     --rate=1                 requests per second
 *     --concurrency=1          parallel requests (2 is the public instance's limit)
 *     --attempts=6             tries per region before it is marked failed
 *     --no-split               do not split a region into quadrants on timeout
 *     --chunk=300              rows per database write
 *     --prune                  delete rows not seen this run (see the guards)
 *     --prune-empty            also prune regions that returned zero elements
 *     --prune-max-pct=20       refuse to prune more than this share of a category
 *     --force-prune            override that guard
 *     --truncate-category=X    wipe a category before re-ingesting it
 *     --error-log=path         JSONL, appended as failures happen
 *     --dry-run                print the plan and the queries, write nothing
 *     --verify                 run only the verification suite
 *
 * Recovering from a failure:
 *   - killed / crashed / Ctrl-C -> re-run the same command. Regions that succeeded
 *     are skipped; regions that failed are retried.
 *   - a region that keeps timing out -> it is split into quadrants automatically.
 *     With --no-split it stays failed and the run exits non-zero.
 *   - a category that came back suspiciously small -> do NOT prune. Check the
 *     verification output first; prune trusts the run that produced it.
 */
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const { OverpassClient, OverpassError } = require('../src/utils/overpassClient');
const {
    CATEGORIES,
    SCOPE_NATIONAL,
    SCOPE_GRID,
    SCOPE_FOOTPRINT,
    TARGET_HIGHWAY,
    categoryFor,
    categoryKeys,
    queryHash,
    nameFrom,
    footprintBufferDeg,
} = require('../src/utils/osmCategories');

const prisma = new PrismaClient();

const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const ONLY = (arg('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const REFETCH = has('refetch');
const MAX_AGE = arg('max-age', '');
const ENDPOINT = arg('endpoint', undefined);
const RATE = Number(arg('rate', 1));
const CONCURRENCY = Number(arg('concurrency', 1));
const ATTEMPTS = Number(arg('attempts', 6));
const NO_SPLIT = has('no-split');
const CHUNK = Number(arg('chunk', 300));
const PRUNE = has('prune');
const PRUNE_EMPTY = has('prune-empty');
const PRUNE_MAX_PCT = Number(arg('prune-max-pct', 20));
const FORCE_PRUNE = has('force-prune');
const TRUNCATE_CATEGORY = arg('truncate-category', '');
const ERROR_LOG = arg('error-log', 'osm-ingest-errors.jsonl');
const DRY_RUN = has('dry-run');
const VERIFY_ONLY = has('verify');

/** India's bounding box, for national records and as the grid's extent. */
const INDIA = { south: 6.0, west: 68.0, north: 37.5, east: 97.5 };

/** Footprint tile size. Small tiles hug our clusters, so less empty area is fetched. */
const FOOTPRINT_TILE_DEG = Number(arg('tile-deg', 0.5));

const RUN_STARTED_AT = new Date();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Appends JSONL immediately, so a kill -9 still leaves a record on disk. */
const appendJsonl = (file, objects) => {
    if (!file || !objects.length) return;
    fs.appendFileSync(file, objects.map((o) => JSON.stringify(o)).join('\n') + '\n');
};

// Ctrl-C stops after the region in flight finishes writing rather than mid-write,
// so the tables never end up behind what has already been fetched.
let stopping = false;
process.on('SIGINT', () => {
    if (stopping) {
        console.error('\nSecond interrupt — exiting now.');
        process.exit(130);
    }
    stopping = true;
    console.error('\nInterrupt received. Finishing the regions in flight, then stopping...');
});

/**
 * The Supabase pooler rejects connections intermittently, and losing a write here
 * means re-fetching data the server already spent time producing.
 */
async function withRetry(label, fn, attempts = 8) {
    for (let i = 0; ; i++) {
        try {
            return await fn();
        } catch (err) {
            if (i >= attempts - 1) throw err;
            const wait = Math.min(2 ** i, 15);
            console.warn(`  ! ${label} failed (attempt ${i + 1}/${attempts}), retrying in ${wait}s`);
            await sleep(wait * 1000);
        }
    }
}

/** Fixed-size worker pool, preserving input order in the results. */
async function runPool(items, worker, concurrency) {
    const results = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
        for (;;) {
            const index = next++;
            if (index >= items.length) return;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}

const parseAge = (spec) => {
    const m = /^(\d+)([dhm])$/.exec(String(spec || '').trim());
    if (!m) return null;
    const mult = { d: 86400e3, h: 3600e3, m: 60e3 }[m[2]];
    return Number(m[1]) * mult;
};

const bboxOf = (r) => `${r.south},${r.west},${r.north},${r.east}`;
const tileKeyOf = (deg, south, west) => `${deg}/${south.toFixed(2)}/${west.toFixed(2)}`;

// --- work list -------------------------------------------------------------

/** Warehouse-derived tiles, expanded so coverage does not stop at a grid line. */
async function footprintRegions() {
    const rows = await withRetry('load warehouse tiles', () => prisma.$queryRawUnsafe(`
        SELECT DISTINCT floor(latitude / ${FOOTPRINT_TILE_DEG}) * ${FOOTPRINT_TILE_DEG} AS south,
                        floor(longitude / ${FOOTPRINT_TILE_DEG}) * ${FOOTPRINT_TILE_DEG} AS west
        FROM "WarehouseData"
        WHERE latitude IS NOT NULL AND longitude IS NOT NULL
          AND latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180
        ORDER BY 1, 2
    `));
    const buffer = footprintBufferDeg();
    return rows.map((r) => ({
        tileKey: tileKeyOf(FOOTPRINT_TILE_DEG, r.south, r.west),
        south: r.south - buffer,
        west: r.west - buffer,
        north: r.south + FOOTPRINT_TILE_DEG + buffer,
        east: r.west + FOOTPRINT_TILE_DEG + buffer,
    }));
}

/** A fixed national grid, for a category too large for one request. */
function gridRegions(deg) {
    const out = [];
    for (let s = INDIA.south; s < INDIA.north; s += deg) {
        for (let w = INDIA.west; w < INDIA.east; w += deg) {
            out.push({
                tileKey: tileKeyOf(deg, s, w),
                south: s, west: w,
                north: Math.min(s + deg, INDIA.north),
                east: Math.min(w + deg, INDIA.east),
            });
        }
    }
    return out;
}

async function regionsFor(category) {
    if (category.scope === SCOPE_NATIONAL) return [{ tileKey: 'national', ...INDIA }];
    if (category.scope === SCOPE_GRID) return gridRegions(category.gridDeg);
    if (category.scope === SCOPE_FOOTPRINT) return footprintRegions();
    throw new Error(`Unknown scope for ${category.key}: ${category.scope}`);
}

/**
 * Every (region, category) that needs fetching, and why.
 *
 * A region is skipped only when it completed under the CURRENT query definition
 * and is not older than --max-age. Anything else is work.
 */
async function buildWorkList(categories) {
    const existing = await withRetry('load ingest records', () => prisma.osmIngestTile.findMany({
        where: { category: { in: categories.map((c) => c.key) } },
        select: { tileKey: true, category: true, status: true, queryHash: true, fetchedAt: true },
    }));
    const byKey = new Map(existing.map((r) => [`${r.category}::${r.tileKey}`, r]));
    const maxAgeMs = parseAge(MAX_AGE);

    const work = [];
    const skipped = [];
    for (const category of categories) {
        const hash = queryHash(category.key);
        for (const region of await regionsFor(category)) {
            const prior = byKey.get(`${category.key}::${region.tileKey}`);
            let reason = null;
            if (!prior) reason = 'new';
            else if (REFETCH) reason = 'refetch';
            else if (!['ok', 'empty'].includes(prior.status)) reason = prior.status;
            else if (prior.queryHash !== hash) reason = 'query changed';
            else if (maxAgeMs && prior.fetchedAt && Date.now() - prior.fetchedAt.getTime() > maxAgeMs) reason = 'stale';

            if (reason) work.push({ category, region, hash, reason });
            else skipped.push({ category: category.key, tileKey: region.tileKey });
        }
    }
    return { work, skipped };
}

// --- normalisation ---------------------------------------------------------

const OSM_TYPE = { node: 'n', way: 'w', relation: 'r' };

/** Coordinates of an element, whether a node or an `out center` way/relation. */
function coordsOf(el) {
    if (Number.isFinite(el.lat) && Number.isFinite(el.lon)) return { lat: el.lat, lng: el.lon };
    if (el.center && Number.isFinite(el.center.lat) && Number.isFinite(el.center.lon)) {
        return { lat: el.center.lat, lng: el.center.lon };
    }
    return null;
}

/**
 * Turn Overpass elements into rows, reporting what was dropped and why.
 *
 * The counts matter as much as the rows: a filter quietly discarding most of a
 * category is invisible in a row total but obvious in a drop ratio, and it is how
 * the substation voltage threshold gets tuned from evidence.
 */
function normalise(category, elements, sourceFile) {
    const rows = [];
    let noCoords = 0;
    let filtered = 0;

    for (const el of elements) {
        const osmType = OSM_TYPE[el.type];
        if (!osmType) continue;
        if (category.keep && !category.keep(el)) { filtered++; continue; }

        if (category.target === TARGET_HIGHWAY) {
            // WKT rather than a coordinate array: simpler to chunk, and it is what
            // ST_GeogFromText wants. Consecutive duplicate points are dropped
            // because a zero-length segment is not valid geometry.
            const points = [];
            for (const p of el.geometry || []) {
                if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
                const last = points[points.length - 1];
                if (last && last[0] === p.lon && last[1] === p.lat) continue;
                points.push([p.lon, p.lat]);
            }
            if (points.length < 2) { noCoords++; continue; }
            rows.push({
                osmType,
                osmId: BigInt(el.id),
                ref: (el.tags && el.tags.ref) || null,
                highway: (el.tags && el.tags.highway) || 'unknown',
                name: nameFrom(el.tags),
                tags: el.tags || {},
                sourceFile,
                wkt: `SRID=4326;LINESTRING(${points.map(([x, y]) => `${x} ${y}`).join(',')})`,
            });
            continue;
        }

        const at = coordsOf(el);
        if (!at) { noCoords++; continue; }
        rows.push({
            osmType,
            osmId: BigInt(el.id),
            category: category.key,
            name: nameFrom(el.tags),
            lat: at.lat,
            lng: at.lng,
            tags: el.tags || {},
            sourceFile,
        });
    }
    return { rows, noCoords, filtered };
}

// --- writes ----------------------------------------------------------------

/**
 * Upsert POI rows.
 *
 * ON CONFLICT DO UPDATE, deliberately NOT createMany({ skipDuplicates: true }).
 * skipDuplicates is this repo's house pattern and it is wrong here: it ignores
 * rows that already exist, so a POI that MOVED upstream would keep its old
 * coordinates forever. In a nearest-neighbour table that is a correctness bug, not
 * an optimisation.
 *
 * `geog` is never named in the column list — it is GENERATED ALWAYS, so Postgres
 * refuses to be told its value, and updating lat/lng recomputes it. That is the
 * entire point of the generated column.
 */
async function upsertPois(rows) {
    if (!rows.length) return 0;
    // Explicit casts on every placeholder. Postgres infers types for a multi-row
    // VALUES list from the first row, so an untyped NULL name or an integer-looking
    // latitude in row one can decide the column type for the whole batch.
    const perRow = 8;
    const seenParam = rows.length * perRow + 1;
    const tuples = rows.map((_, i) => {
        const b = i * perRow;
        return `($${b + 1}::char(1), $${b + 2}::bigint, $${b + 3}::text, $${b + 4}::text,`
            + ` $${b + 5}::double precision, $${b + 6}::double precision, $${b + 7}::jsonb,`
            + ` $${b + 8}::text, $${seenParam}::timestamptz)`;
    }).join(', ');
    const params = rows.flatMap((r) => [
        r.osmType, r.osmId, r.category, r.name, r.lat, r.lng, JSON.stringify(r.tags), r.sourceFile,
    ]);
    // importedAt is deliberately absent from the update set, so it keeps meaning
    // "first seen" for the life of the row. geog is never named at all — it is
    // GENERATED ALWAYS, so Postgres refuses to be told its value, and updating
    // lat/lng recomputes it. That is the entire point of the generated column.
    const sql = `
        INSERT INTO osm_poi ("osmType","osmId",category,name,lat,lng,tags,"sourceFile","lastSeenAt")
        VALUES ${tuples}
        ON CONFLICT ("osmType","osmId",category) DO UPDATE SET
            name = EXCLUDED.name,
            lat = EXCLUDED.lat,
            lng = EXCLUDED.lng,
            tags = EXCLUDED.tags,
            "sourceFile" = EXCLUDED."sourceFile",
            "lastSeenAt" = EXCLUDED."lastSeenAt"`;
    return prisma.$executeRawUnsafe(sql, ...params, RUN_STARTED_AT);
}

/**
 * Upsert highway lines. Same ON CONFLICT reasoning as upsertPois.
 *
 * geog IS written here: unlike the point tables there is no lat/lng to generate it
 * from, so the linestring is the source of truth. ST_GeogFromText parses the
 * SRID=4326;LINESTRING(...) text built during normalisation.
 */
async function upsertHighways(rows) {
    if (!rows.length) return 0;
    const perRow = 8;
    const seenParam = rows.length * perRow + 1;
    const tuples = rows.map((_, i) => {
        const b = i * perRow;
        return `($${b + 1}::char(1), $${b + 2}::bigint, $${b + 3}::text, $${b + 4}::text,`
            + ` $${b + 5}::text, $${b + 6}::jsonb, $${b + 7}::text, $${seenParam}::timestamptz,`
            + ` ST_GeogFromText($${b + 8}::text))`;
    }).join(', ');
    const params = rows.flatMap((r) => [
        r.osmType, r.osmId, r.ref, r.highway, r.name, JSON.stringify(r.tags), r.sourceFile, r.wkt,
    ]);
    const sql = `
        INSERT INTO osm_highway ("osmType","osmId",ref,highway,name,tags,"sourceFile","lastSeenAt",geog)
        VALUES ${tuples}
        ON CONFLICT ("osmType","osmId") DO UPDATE SET
            ref = EXCLUDED.ref,
            highway = EXCLUDED.highway,
            name = EXCLUDED.name,
            tags = EXCLUDED.tags,
            "sourceFile" = EXCLUDED."sourceFile",
            "lastSeenAt" = EXCLUDED."lastSeenAt",
            geog = EXCLUDED.geog`;
    return prisma.$executeRawUnsafe(sql, ...params, RUN_STARTED_AT);
}

/**
 * Record the outcome of one (region, category) fetch.
 *
 * Callers express a counter bump as `{ increment: 1 }`, which Prisma accepts in an
 * update but NOT in a create — and upsert hands the same object to both branches.
 * Translating it here keeps that quirk in one place instead of at every call site.
 */
async function recordRegion({ category, region, hash }, patch) {
    const forCreate = Object.fromEntries(Object.entries(patch).map(([key, value]) => (
        value && typeof value === 'object' && 'increment' in value
            ? [key, value.increment]
            : [key, value]
    )));

    return withRetry('record region', () => prisma.osmIngestTile.upsert({
        where: { tileKey_category: { tileKey: region.tileKey, category: category.key } },
        create: {
            tileKey: region.tileKey,
            category: category.key,
            south: region.south, west: region.west, north: region.north, east: region.east,
            queryHash: hash,
            ...forCreate,
        },
        update: { queryHash: hash, ...patch },
    }));
}

module.exports = { normalise, coordsOf, parseAge, gridRegions, runPool, upsertPois, upsertHighways };

// The script body only runs when invoked directly, so the pure helpers above can
// be unit-tested without a database or a network.
if (require.main === module) {
    main()
        .catch((err) => { console.error('ERR:', err && err.message); process.exit(1); })
        .finally(() => prisma.$disconnect());
}

// --- main ------------------------------------------------------------------

async function main() {
    if (VERIFY_ONLY) return verify();

    const selected = CATEGORIES.filter((c) => !ONLY.length || ONLY.includes(c.key));
    if (!selected.length) {
        console.error(`No categories matched --only. Known: ${categoryKeys().join(', ')}`);
        process.exit(1);
    }

    if (TRUNCATE_CATEGORY) {
        const target = categoryFor(TRUNCATE_CATEGORY);
        if (!target) { console.error(`Unknown category: ${TRUNCATE_CATEGORY}`); process.exit(1); }
        if (DRY_RUN) {
            console.log(`[dry-run] would delete every ${TRUNCATE_CATEGORY} row and its ingest records`);
        } else {
            const table = target.target === TARGET_HIGHWAY ? 'osm_highway' : 'osm_poi';
            const deleted = target.target === TARGET_HIGHWAY
                ? await prisma.$executeRawUnsafe('DELETE FROM osm_highway')
                : await prisma.$executeRawUnsafe('DELETE FROM osm_poi WHERE category = $1', TRUNCATE_CATEGORY);
            await prisma.osmIngestTile.deleteMany({ where: { category: TRUNCATE_CATEGORY } });
            console.log(`Truncated ${deleted} row(s) from ${table} for ${TRUNCATE_CATEGORY}`);
        }
    }

    const { work, skipped } = await buildWorkList(selected);

    console.log(`\n=== plan ===`);
    console.log(`  endpoint     ${ENDPOINT || process.env.OVERPASS_ENDPOINT || 'overpass-api.de (default)'}`);
    console.log(`  categories   ${selected.map((c) => c.key).join(', ')}`);
    console.log(`  to fetch     ${work.length} region-category pair(s)`);
    console.log(`  up to date   ${skipped.length}`);
    if (work.length) {
        const byReason = work.reduce((acc, w) => ({ ...acc, [w.reason]: (acc[w.reason] || 0) + 1 }), {});
        console.log(`  reasons      ${Object.entries(byReason).map(([k, v]) => `${k}=${v}`).join(' ')}`);
        const byCat = work.reduce((acc, w) => ({ ...acc, [w.category.key]: (acc[w.category.key] || 0) + 1 }), {});
        Object.entries(byCat).forEach(([k, v]) => console.log(`     ${k.padEnd(18)} ${v} request(s)`));
    }

    if (!work.length) {
        console.log('\nNothing to do.');
        return verify();
    }

    if (DRY_RUN) {
        const sample = work[0];
        console.log(`\n[dry-run] first query (${sample.category.key} @ ${sample.region.tileKey}):\n`);
        console.log(sample.category.ql(sample.category.scope === SCOPE_NATIONAL ? null : bboxOf(sample.region)));
        console.log('\n[dry-run] nothing was fetched or written.');
        return;
    }

    const client = new OverpassClient({
        endpoint: ENDPOINT, ratePerSec: RATE, attempts: ATTEMPTS,
    });

    const totals = { ok: 0, empty: 0, failed: 0, stored: 0, elements: 0, filtered: 0, noCoords: 0, split: 0 };
    const queue = [...work];
    const startedAt = Date.now();
    let done = 0;

    // A plain for-loop over a growing queue rather than a single runPool pass,
    // because a timed-out region can add quadrant children to the work.
    while (queue.length && !stopping) {
        const batch = queue.splice(0, Math.max(1, CONCURRENCY));
        const outcomes = await runPool(batch, (item) => fetchOne(client, item, totals), CONCURRENCY);
        for (const extra of outcomes.flatMap((o) => (o && o.children) || [])) queue.push(extra);

        done += batch.length;
        const elapsed = (Date.now() - startedAt) / 1000;
        const pct = Math.round((done / (done + queue.length)) * 100);
        const eta = queue.length ? Math.round((elapsed / done) * queue.length) : 0;
        console.log(
            `  ${String(pct).padStart(3)}%  ${done}/${done + queue.length}  `
            + `stored ${totals.stored}  failed ${totals.failed}  ${elapsed.toFixed(0)}s elapsed, eta ${eta}s`,
        );
    }

    if (stopping && queue.length) {
        console.log(`\nStopped with ${queue.length} region(s) still to fetch. Re-run the same command to continue.`);
    }

    console.log(`\n=== totals ===`);
    console.log(`  ok ${totals.ok}  empty ${totals.empty}  failed ${totals.failed}  split ${totals.split}`);
    console.log(`  elements ${totals.elements}  stored ${totals.stored}  `
        + `filtered out ${totals.filtered}  without coordinates ${totals.noCoords}`);

    if (PRUNE) await prune(selected);

    await verify();

    if (totals.failed > 0) {
        console.error(`\n${totals.failed} region(s) failed permanently. A partial ingest must not look like a success.`);
        process.exitCode = 1;
    }
}

/** Fetch, normalise and store one (region, category). Never throws. */
async function fetchOne(client, item, totals) {
    const { category, region } = item;
    const label = `${category.key}@${region.tileKey}`;
    const box = category.scope === SCOPE_NATIONAL ? null : bboxOf(region);
    const ql = category.ql(box);

    let response;
    try {
        response = await client.fetch(ql, { label });
    } catch (err) {
        const timedOut = err instanceof OverpassError && err.kind === 'remark';
        // A region too dense to answer becomes four smaller ones rather than a
        // permanent hole. The size lives in the tile key, so no schema change.
        if (timedOut && !NO_SPLIT && category.scope !== SCOPE_NATIONAL) {
            const children = quadrants(item);
            if (children.length) {
                totals.split++;
                await recordRegion(item, {
                    status: 'skipped',
                    lastError: 'split into quadrants after a timeout',
                    attempts: { increment: 1 },
                    fetchedAt: new Date(),
                });
                console.warn(`  ~ ${label} timed out; split into ${children.length} quadrants`);
                return { children };
            }
        }
        totals.failed++;
        appendJsonl(ERROR_LOG, [{
            at: new Date().toISOString(), category: category.key, tileKey: region.tileKey,
            kind: err.kind, status: err.status, message: err.message,
        }]);
        await recordRegion(item, {
            status: 'failed',
            lastError: String(err.message).slice(0, 500),
            attempts: { increment: 1 },
            fetchedAt: new Date(),
        });
        console.error(`  x ${label}: ${err.message.slice(0, 110)}`);
        return {};
    }

    const sourceFile = `overpass:${client.host}:${category.key}:${region.tileKey}:`
        + `${RUN_STARTED_AT.toISOString().slice(0, 10)}`;
    const { rows, noCoords, filtered } = normalise(category, response.elements, sourceFile);

    let stored = 0;
    try {
        for (let i = 0; i < rows.length; i += CHUNK) {
            const slice = rows.slice(i, i + CHUNK);
            await withRetry(`write ${label}`, () => (category.target === TARGET_HIGHWAY
                ? upsertHighways(slice)
                : upsertPois(slice)));
            stored += slice.length;
        }
    } catch (err) {
        totals.failed++;
        appendJsonl(ERROR_LOG, [{
            at: new Date().toISOString(), category: category.key, tileKey: region.tileKey,
            kind: 'write', message: err.message,
        }]);
        await recordRegion(item, {
            status: 'failed',
            lastError: `write failed: ${String(err.message).slice(0, 460)}`,
            attempts: { increment: 1 },
            elementCount: response.elements.length,
            storedCount: stored,
            fetchedAt: new Date(),
        });
        console.error(`  x ${label}: write failed after ${stored} row(s): ${err.message.slice(0, 90)}`);
        return {};
    }

    totals.elements += response.elements.length;
    totals.stored += stored;
    totals.filtered += filtered;
    totals.noCoords += noCoords;

    // 'empty' means the fetch completed and genuinely returned nothing. It is a
    // separate status from 'ok' so it can be audited, because a truncated response
    // and an empty region are otherwise indistinguishable.
    const status = response.elements.length === 0 ? 'empty' : 'ok';
    if (status === 'empty') totals.empty++; else totals.ok++;

    await recordRegion(item, {
        status,
        elementCount: response.elements.length,
        storedCount: stored,
        attempts: { increment: 1 },
        lastError: null,
        durationMs: response.durationMs,
        bytes: response.bytes,
        fetchedAt: new Date(),
    });

    const drop = response.elements.length - stored;
    console.log(`  + ${label}: ${response.elements.length} elements -> ${stored} stored`
        + `${drop ? ` (${filtered} filtered, ${noCoords} without coordinates)` : ''}`
        + `  ${response.durationMs}ms ${Math.round(response.bytes / 1024)}kB`);
    return {};
}

/** Split a region into four, at half the tile size. */
function quadrants(item) {
    const { region, category, hash } = item;
    const midLat = (region.south + region.north) / 2;
    const midLng = (region.west + region.east) / 2;
    const deg = (region.north - region.south) / 2;
    if (deg < 0.05) return [];   // below this, splitting is not the problem
    return [
        { south: region.south, west: region.west, north: midLat, east: midLng },
        { south: region.south, west: midLng, north: midLat, east: region.east },
        { south: midLat, west: region.west, north: region.north, east: midLng },
        { south: midLat, west: midLng, north: region.north, east: region.east },
    ].map((r) => ({
        category,
        hash,
        reason: 'quadrant of a timed-out region',
        region: { ...r, tileKey: tileKeyOf(Number(deg.toFixed(3)), r.south, r.west) },
    }));
}

/**
 * Delete rows this run did not see, scoped to regions it actually covered.
 *
 * Not delete-then-insert per region: the pooler cannot do interactive transactions
 * (P2028), so that is two statements, and a crash between them leaves a HOLE.
 * Stale data is strictly better than a hole, because a hole reads downstream as
 * "there is nothing of this kind anywhere near this warehouse".
 */
async function prune(categories) {
    console.log('\n=== prune ===');
    for (const category of categories) {
        const table = category.target === TARGET_HIGHWAY ? 'osm_highway' : 'osm_poi';
        const scope = category.target === TARGET_HIGHWAY ? '' : 'AND category = $2';

        const allowed = ['ok'].concat(PRUNE_EMPTY ? ['empty'] : []);
        const regions = await prisma.osmIngestTile.findMany({
            where: { category: category.key, status: { in: allowed }, fetchedAt: { gte: RUN_STARTED_AT } },
            select: { tileKey: true, south: true, west: true, north: true, east: true },
        });
        if (!regions.length) {
            console.log(`  ${category.key}: no region completed in this run — nothing pruned`);
            continue;
        }

        const total = Number((await prisma.$queryRawUnsafe(
            `SELECT count(*)::int n FROM ${table} WHERE TRUE ${scope.replace('$2', `'${category.key}'`)}`,
        ))[0].n);

        let candidates = 0;
        for (const r of regions) {
            const rows = await prisma.$queryRawUnsafe(
                `SELECT count(*)::int n FROM ${table}
                 WHERE "lastSeenAt" < $1 ${scope.replace('$2', `'${category.key}'`)}
                   AND geog && ST_MakeEnvelope(${r.west}, ${r.south}, ${r.east}, ${r.north}, 4326)::geography`,
                RUN_STARTED_AT,
            );
            candidates += Number(rows[0].n);
        }

        const pct = total ? (candidates / total) * 100 : 0;
        if (!candidates) {
            console.log(`  ${category.key}: nothing to prune`);
            continue;
        }
        // One bad Overpass day must not be able to empty a category.
        if (pct > PRUNE_MAX_PCT && !FORCE_PRUNE) {
            console.error(`  ${category.key}: REFUSING to prune ${candidates}/${total} rows (${pct.toFixed(1)}%) `
                + `— above --prune-max-pct=${PRUNE_MAX_PCT}. Check the census, then use --force-prune if it is right.`);
            process.exitCode = 1;
            continue;
        }

        let deleted = 0;
        for (const r of regions) {
            deleted += await prisma.$executeRawUnsafe(
                `DELETE FROM ${table}
                 WHERE "lastSeenAt" < $1 ${scope.replace('$2', `'${category.key}'`)}
                   AND geog && ST_MakeEnvelope(${r.west}, ${r.south}, ${r.east}, ${r.north}, 4326)::geography`,
                RUN_STARTED_AT,
            );
        }
        console.log(`  ${category.key}: pruned ${deleted} row(s) gone upstream (${pct.toFixed(1)}% of ${total})`);
    }
}

// --- verification ----------------------------------------------------------

/**
 * Escalating checks, in the style of scripts/setupGeoColumns.js: structural, then
 * indexes, then coverage, then the detectors that catch a run which "succeeded"
 * while quietly storing nothing.
 */
async function verify() {
    console.log('\n=== verification ===');
    let hardFail = false;

    // 1. structural
    const cols = await prisma.$queryRawUnsafe(`
        SELECT c.table_name, c.is_generated,
               format_type(a.atttypid, a.atttypmod) AS full_type
        FROM information_schema.columns c
        JOIN pg_attribute a ON a.attrelid = format('%I.%I', c.table_schema, c.table_name)::regclass
                           AND a.attname = c.column_name
        WHERE c.column_name = 'geog' AND c.table_schema = 'public'
          AND c.table_name IN ('osm_poi','osm_highway')
        ORDER BY c.table_name`);
    cols.forEach((c) => console.log(`  ${c.table_name.padEnd(14)} ${c.full_type.padEnd(30)} generated=${c.is_generated}`));
    const poi = cols.find((c) => c.table_name === 'osm_poi');
    if (!poi || poi.is_generated !== 'ALWAYS') {
        console.error('  FAIL: osm_poi.geog is not GENERATED — lat/lng upserts will not move the geography');
        hardFail = true;
    }

    // 2. indexes
    const idx = await prisma.$queryRawUnsafe(`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename IN ('osm_poi','osm_highway','osm_ingest_tile')
        ORDER BY indexname`);
    console.log(`  indexes: ${idx.map((i) => i.indexname).join(', ')}`);
    for (const needed of ['osm_poi_geog_gist', 'osm_highway_geog_gist']) {
        if (!idx.some((i) => i.indexname === needed)) {
            console.error(`  FAIL: missing spatial index ${needed}`);
            hardFail = true;
        }
    }

    // 3. coverage and query drift
    const records = await prisma.osmIngestTile.groupBy({
        by: ['category', 'status'], _count: { _all: true },
    });
    const byCat = new Map();
    records.forEach((r) => {
        if (!byCat.has(r.category)) byCat.set(r.category, {});
        byCat.get(r.category)[r.status] = r._count._all;
    });
    console.log('\n  region status by category:');
    for (const key of categoryKeys()) {
        const s = byCat.get(key);
        if (!s) { console.log(`    ${key.padEnd(18)} never fetched`); continue; }
        const parts = Object.entries(s).map(([k, v]) => `${k}=${v}`).join(' ');
        console.log(`    ${key.padEnd(18)} ${parts}`);
        if (s.failed) hardFail = true;
    }
    if (records.some((r) => r.status === 'failed')) {
        console.error('  FAIL: regions in a failed state — the data has holes');
    }

    const drift = await prisma.osmIngestTile.findMany({ select: { category: true, queryHash: true } });
    const stale = drift.filter((r) => {
        try { return r.queryHash !== queryHash(r.category); } catch (_) { return false; }
    });
    if (stale.length) {
        console.warn(`  WARN: ${stale.length} record(s) were built from a superseded query definition — re-run to refresh`);
    }

    // 4. counts, national floors, and the drop ratio
    const counts = await prisma.$queryRawUnsafe(
        'SELECT category, count(*)::int n FROM osm_poi GROUP BY category ORDER BY n DESC');
    const highways = Number((await prisma.$queryRawUnsafe('SELECT count(*)::int n FROM osm_highway'))[0].n);
    console.log('\n  stored rows:');
    counts.forEach((c) => console.log(`    ${c.category.padEnd(18)} ${String(c.n).padStart(7)}`));
    console.log(`    ${'national_highway'.padEnd(18)} ${String(highways).padStart(7)}  (osm_highway)`);

    for (const key of categoryKeys()) {
        const category = categoryFor(key);
        if (!category.minExpected) continue;
        const got = category.target === TARGET_HIGHWAY
            ? highways
            : Number((counts.find((c) => c.category === key) || { n: 0 }).n);
        const fetched = byCat.get(key);
        if (!fetched) continue;
        if (got < category.minExpected) {
            // Catches the specific silent failure of area["ISO3166-1"="IN"] not
            // resolving: the public instance rebuilds its areas nightly, and a
            // missing area returns HTTP 200 with zero elements.
            console.error(`  FAIL: ${key} has ${got} rows, below its floor of ${category.minExpected}`);
            hardFail = true;
        }
    }

    // 5. the zero-element detectors
    const empties = await prisma.osmIngestTile.findMany({
        where: { status: 'empty' }, select: { category: true, tileKey: true },
    });
    const mustExist = empties.filter((e) => {
        const c = categoryFor(e.category);
        return c && c.mustExistNearWarehouses;
    });
    if (mustExist.length) {
        // These categories exist in any populated place. Empty is not a fact here.
        console.error(`  FAIL: ${mustExist.length} region(s) returned nothing for a category that must exist `
            + `near any settlement: ${mustExist.slice(0, 5).map((e) => `${e.category}@${e.tileKey}`).join(', ')}`);
        hardFail = true;
    } else if (empties.length) {
        console.log(`  ${empties.length} region(s) genuinely empty (sparse categories only)`);
    }

    const ratios = await prisma.$queryRawUnsafe(`
        SELECT category, sum("elementCount")::int el, sum("storedCount")::int st
        FROM osm_ingest_tile WHERE status = 'ok' GROUP BY category ORDER BY category`);
    const lossy = ratios.filter((r) => r.el > 100 && r.st / r.el < 0.5);
    if (lossy.length) {
        console.warn('  WARN: filters are discarding most of what was fetched — tune the threshold or widen the filter:');
        lossy.forEach((r) => console.warn(`    ${r.category}: kept ${r.st} of ${r.el} (${Math.round((r.st / r.el) * 100)}%)`));
    }

    // 6. behavioural — the geography must actually be populated and queryable
    const geo = await prisma.$queryRawUnsafe(
        'SELECT count(*)::int total, count(geog)::int with_geog FROM osm_poi');
    console.log(`\n  osm_poi: ${geo[0].with_geog}/${geo[0].total} rows have a geography`);
    if (geo[0].total !== geo[0].with_geog) {
        console.error('  FAIL: rows exist with no geography — they can never match a spatial query');
        hardFail = true;
    }

    if (hardFail) process.exitCode = 1;
    console.log(hardFail ? '\n  VERIFICATION FAILED' : '\n  verification passed');
}
