/**
 * Store the routed drive distance to the nearest numbered highway.
 *
 * Reads the JSONL that tools/highway-entry/probe.js produces (one file per zone)
 * and writes it into warehouse_proximity's `national_highway` rows.
 *
 * WHAT CHANGES, AND WHY IT IS AN UPDATE RATHER THAN AN INSERT. Those 1,524 rows
 * already exist, carrying a designation and no distance — the deck prints "NH44"
 * with no kilometres because a distance to a LINE had no honest answer while the
 * only tools were a shortlist of tagged points and a metered routing API. There is
 * now an answer, so the same rows gain roadKm, driveMinutes and the entry point.
 *
 * THREE THINGS THIS DELIBERATELY OVERWRITES:
 *
 *   landmarkName — measured, routing names a DIFFERENT highway than straight-line
 *   selection did for 9.0% of warehouses (87 of 972). Writing the distance while
 *   keeping the old name would attach a correct number to the wrong road, which is
 *   worse than either alone.
 *
 *   poiId — for the same reason. It points at the line-nearest way; leaving it
 *   while the name and distance move would make the row untraceable.
 *
 *   provider/profile — these become osrm-local/driving. A number in a deck sent
 *   last quarter must stay explainable, and these did not come from Mapbox.
 *
 * WHAT IT REFUSES TO WRITE. A row whose winning sample snapped more than 50m from
 * the centreline measured some other road, so it is skipped rather than stored
 * with a caveat nobody will read. (Measured: 0 of 972 in the southern run, but the
 * guard is the reason that number can be trusted.)
 *
 * The coordinate-quality flag is recorded as a WARNING, not as a refusal: a pin
 * 600m from any road still has a real distance from wherever it is, and the fix
 * belongs with whoever owns the pin.
 *
 * Usage:
 *   node -r dotenv/config scripts/backfillHighwayEntry.js --dry-run
 *   node -r dotenv/config scripts/backfillHighwayEntry.js --in=tools/highway-entry/zone-*.jsonl
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const CATEGORY = 'national_highway';
const PROVIDER = 'osrm-local';
const PROFILE = 'driving';
/** Beyond this the sample was not on the highway. See the header. */
const MAX_ENTRY_SNAP_M = 50;
/** A pin further than this from any road is a data defect worth flagging. */
const COORD_SUSPECT_M = 150;

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const inputs = args.filter((a) => a.startsWith('--in=')).flatMap((a) => a.slice(5).split(','));
/**
 * Create a national_highway row where none exists.
 *
 * Off by default and gated behind a flag because a missing row means the identity
 * pass never covered that warehouse — 13 of 972, presumably added after the last
 * proximity sweep. Silently creating them would hide the fact that the sweep is
 * behind; refusing forever would strand real measurements. So it is surfaced once,
 * then written on request.
 */
const CREATE_MISSING = args.includes('--create-missing');

/**
 * Drive time, floored at one minute for any real route.
 *
 * Math.round gives 0 for anything under 30 seconds, and a deck row reading
 * "0.43 km · 0 min" reads as a broken field rather than as a short drive. Same
 * defect, same fix as roadKm's 0.01km floor, which was added after three
 * hospitals 8-36m from their warehouse stored as 0.
 *
 * Applied here rather than only in the probe so that JSONL already written with
 * zeros is corrected on the way into the database.
 */
const floorMinutes = (mins, km) => {
    if (!Number.isFinite(mins)) return null;
    const r = Math.round(mins);
    return r === 0 && km > 0 ? 1 : r;
};

/**
 * A warehouse whose access is ON the highway.
 *
 * 9 of 972 route to 0.00km: the origin and the entry point snap to the same
 * position on the carriageway, so there is genuinely no distance to travel. That
 * is the strongest possible version of this fact and a selling point — but
 * "NH44 · 0 km · 0 min" reads as a broken field, the same way three hospitals
 * stored as 0km did.
 *
 * So the row carries a floor AND an ON_HIGHWAY warning, which lets a deck say
 * "Directly on NH44" instead of printing a zero. The floor alone would turn a
 * remarkable fact into an unremarkable 0.01km.
 */
const ON_HIGHWAY = 'ON_HIGHWAY';
const MIN_KM = 0.01;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The pooler refused connections repeatedly while this data was being produced. */
async function withRetry(label, fn, attempts = 5) {
    for (let i = 1; ; i++) {
        try {
            return await fn();
        } catch (err) {
            if (i >= attempts) throw err;
            const wait = 1000 * 2 ** (i - 1);
            console.error(`  ${label} failed (${i}/${attempts}) — retrying in ${wait}ms`);
            await sleep(wait);
        }
    }
}

function loadRows(files) {
    const seen = new Map();
    for (const f of files) {
        const full = path.isAbsolute(f) ? f : path.join(process.cwd(), f);
        if (!fs.existsSync(full)) {
            console.error(`  no such file: ${full}`);
            continue;
        }
        let n = 0;
        for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            const r = JSON.parse(line);
            // A warehouse within 10km of a zone border appears in two zones' output.
            // Keep the SHORTER distance: the border clips a graph, so the zone that
            // returns less had more of the relevant road network, never less.
            const prev = seen.get(r.warehouseId);
            if (!prev || r.routed.roadKm < prev.routed.roadKm) seen.set(r.warehouseId, r);
            n += 1;
        }
        console.log(`  ${path.basename(full)}: ${n} rows`);
    }
    return [...seen.values()];
}

(async () => {
    const files = inputs.length ? inputs
        : fs.readdirSync(path.join(__dirname, '..', 'tools', 'highway-entry'))
            .filter((f) => /^zone-.*\.jsonl$/.test(f))
            .map((f) => path.join(__dirname, '..', 'tools', 'highway-entry', f));

    if (!files.length) {
        console.error('No zone-*.jsonl found. Run tools/highway-entry/probe.js first.');
        process.exit(1);
    }
    console.log('reading:');
    const rows = loadRows(files);
    console.log(`\n${rows.length} distinct warehouses`);

    const usable = rows.filter((r) => r.routed.snapM !== null && r.routed.snapM <= MAX_ENTRY_SNAP_M);
    const rejected = rows.length - usable.length;
    const suspects = usable.filter((r) => (r.originSnapM ?? 0) > COORD_SUSPECT_M);
    const renamed = usable.filter((r) => r.refChanged);

    console.log(`  writable                     ${usable.length}`);
    console.log(`  rejected (entry snap >${MAX_ENTRY_SNAP_M}m)   ${rejected}`);
    console.log(`  designation corrected        ${renamed.length}`);
    console.log(`  coordinate suspects flagged  ${suspects.length}`);

    if (DRY) {
        console.log('\n--dry-run: nothing written. Sample of what would change:');
        for (const r of usable.slice(0, 5)) {
            console.log(`  wh${r.warehouseId}: ${r.printedToday.ref} -> ${r.routed.ref}`
                + `  ${r.routed.roadKm}km / ${floorMinutes(r.routed.driveMinutes, r.routed.roadKm)}min`
                + `  entry ${r.routed.entryLat},${r.routed.entryLng}`);
        }
        return;
    }

    const prisma = new PrismaClient();

    // The warehouse coordinates each measurement was taken FROM.
    //
    // computedFromLat/Lng is what makes a corrected coordinate invalidate the row
    // by construction — no hook, no timestamp comparison, and it works when
    // someone fixes a pin with raw SQL. The probe never recorded the origin it
    // used, so a created row would carry nulls here and could never be detected as
    // stale. Updated rows already hold these from the identity pass, taken from
    // the same coordinates, so only creations need them.
    const coords = Object.fromEntries((await withRetry('coords', () => prisma.$queryRawUnsafe(`
        SELECT d."warehouseId" AS id, d.latitude AS lat, d.longitude AS lng
        FROM "WarehouseData" d
        WHERE d."warehouseId" IN (${usable.map((r) => r.warehouseId).join(',')})`)))
        .map((c) => [c.id, c]));

    let updated = 0;
    let missing = 0;
    let created = 0;
    /**
     * One statement per chunk, not one per warehouse.
     *
     * The first version looped, issuing an updateMany per row. That is ~600ms of
     * pooler round trip each and 1,540 rows took thirteen minutes to write data
     * that was already computed — the pass does no geometry and no routing, it
     * only stores. A VALUES join does the same work in one round trip per chunk.
     *
     * Placeholders rather than interpolation: landmark names are OSM free text
     * ("P.V. Narasimha Rao Flyover", names carrying apostrophes), and every column
     * is cast explicitly because Postgres cannot infer types from a bare VALUES
     * list.
     */
    const COLS = 9;
    const CHUNK = 400;
    const rowsFor = (r) => {
        const warnings = [];
        if (r.refChanged) warnings.push('DESIGNATION_CORRECTED_BY_ROUTING');
        if ((r.originSnapM ?? 0) > COORD_SUSPECT_M) warnings.push('WAREHOUSE_FAR_FROM_ROAD');
        const onHighway = !(r.routed.roadKm > 0);
        if (onHighway) warnings.push(ON_HIGHWAY);
        const roadKm = onHighway ? MIN_KM : r.routed.roadKm;
        return [
            r.warehouseId,
            r.routed.ref || null,
            r.routed.highwayId === undefined ? null : String(r.routed.highwayId),
            r.routed.entryLat ?? null,
            r.routed.entryLng ?? null,
            roadKm,
            onHighway ? 1 : floorMinutes(r.routed.driveMinutes, roadKm),
            r.samples,
            warnings,
        ];
    };

    for (let i = 0; i < usable.length; i += CHUNK) {
        const chunk = usable.slice(i, i + CHUNK);
        const params = [];
        const tuples = chunk.map((r, j) => {
            params.push(...rowsFor(r));
            const b = j * COLS;
            return `($${b + 1}::int, $${b + 2}::text, $${b + 3}::text, $${b + 4}::double precision,`
                + ` $${b + 5}::double precision, $${b + 6}::double precision, $${b + 7}::int,`
                + ` $${b + 8}::int, $${b + 9}::text[])`;
        }).join(', ');

        const n = await withRetry(`update ${i}-${i + chunk.length}`, () => prisma.$executeRawUnsafe(`
            UPDATE warehouse_proximity p SET
                status = 'OK',
                "landmarkName" = v.name,
                "poiSource" = 'osm_highway',
                "poiId" = v.poi_id,
                "poiLat" = v.lat,
                "poiLng" = v.lng,
                "roadKm" = v.road_km,
                "driveMinutes" = v.mins,
                provider = '${PROVIDER}',
                profile = '${PROFILE}',
                candidates = v.cands,
                warnings = v.warnings,
                "computedAt" = now()
            FROM (VALUES ${tuples})
                AS v(wh_id, name, poi_id, lat, lng, road_km, mins, cands, warnings)
            WHERE p."warehouseId" = v.wh_id AND p.category = '${CATEGORY}'`, ...params));
        updated += n;
        process.stdout.write(`\r  updated ${updated}/${usable.length}`);
    }
    process.stdout.write('\n');

    // Whatever has no row yet. Separate because it is a different statement and a
    // different decision — see CREATE_MISSING.
    const haveRows = new Set((await withRetry('existing', () => prisma.$queryRawUnsafe(`
        SELECT "warehouseId" AS id FROM warehouse_proximity
        WHERE category = '${CATEGORY}'
          AND "warehouseId" IN (${usable.map((r) => r.warehouseId).join(',')})`)))
        .map((x) => x.id));
    const absent = usable.filter((r) => !haveRows.has(r.warehouseId));
    missing = absent.length;

    if (absent.length && CREATE_MISSING) {
        for (const r of absent) {
            const [, name, poiId, lat, lng, roadKm, mins, cands, warnings] = rowsFor(r);
            await withRetry(`create wh${r.warehouseId}`, () => prisma.warehouseProximity.create({
                data: {
                    warehouseId: r.warehouseId,
                    category: CATEGORY,
                    status: 'OK',
                    landmarkName: name,
                    poiSource: 'osm_highway',
                    poiId,
                    poiLat: lat,
                    poiLng: lng,
                    roadKm,
                    driveMinutes: mins,
                    provider: PROVIDER,
                    profile: PROFILE,
                    candidates: cands,
                    warnings,
                    computedFromLat: coords[r.warehouseId] ? coords[r.warehouseId].lat : null,
                    computedFromLng: coords[r.warehouseId] ? coords[r.warehouseId].lng : null,
                },
            }));
            created += 1;
        }
    }

    console.log(`\nupdated ${updated} rows${created ? `, created ${created}` : ''}`);
    if (missing) {
        console.log(`  ${missing} warehouses had NO ${CATEGORY} row${CREATE_MISSING ? '' : ' to update'}`);
        if (!CREATE_MISSING) {
            console.log('  — the identity pass never covered them. Re-run with --create-missing');
            console.log('    to write them, or run the proximity backfill to fill the gap properly.');
        }
    }
    await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
