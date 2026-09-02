/**
 * Can we honestly report the drive distance to the nearest numbered highway?
 *
 * THE PROBLEM. A highway is a LINE, so "distance to it" has no single endpoint to
 * route to. The deployed pipeline therefore reports the DESIGNATION only (NH44,
 * SH104) and no distance, on the grounds that 94.3% of India's numbered-highway
 * mileage is trunk or primary rather than access-controlled, and OSM has no
 * reason to tag the ordinary crossroads where you actually join those.
 *
 * WHY THAT REASONING IS INCOMPLETE. The junctions are not missing from OSM — they
 * are missing as TAGS. Wherever a local road meets NH44 the two ways share a node,
 * which is precisely why routing works at all. A router can therefore find a real,
 * legal entry without anyone having labelled it. What blocked us was never the
 * data; it was that a shortlist of tagged points cannot ask the question, and
 * sampling a line costs one routing call per sample — unaffordable per-request,
 * free on a local engine.
 *
 * SO THIS ASKS IT PROPERLY: densify every numbered highway near the warehouse into
 * points every SAMPLE_M metres, route to all of them in one /table call, and take
 * the true minimum. The winning sample IS the entry point, discovered rather than
 * declared.
 *
 * THREE THINGS IT CHECKS, because the answer is only worth having if it survives
 * them:
 *
 *   1. SNAPPING. A sample sits on the centreline; OSRM snaps it to the nearest
 *      routable edge, which may be a parallel service road. Then the number
 *      measures the service road, not the highway. The winner's snap distance is
 *      reported so this is visible rather than assumed.
 *   2. IDENTITY. The highway nearest by straight line need not be the one nearest
 *      by road. If routing picks a different road, the designation the deck prints
 *      today is also wrong, not just the distance.
 *   3. WHETHER THE TAGGED ACCESS POINTS WERE EVER ANY GOOD. The ingest stored
 *      19,860 highway_access nodes. Routing to those is compared against the
 *      sampled answer, which finally tests the claim that they are unusable
 *      instead of repeating it.
 *
 * Usage: node -r dotenv/config tools/highway-entry/probe.js --ids=995,1065
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const osrm = require('../../src/utils/osrmRouting');

const arg = (n, d) => {
    const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.split('=').slice(1).join('=') : d;
};

const IDS = (arg('ids', '') || '').split(',').map(Number).filter(Boolean);
const LIMIT = Number(arg('limit', 25));
/** How far out to look for a highway to join. Beyond ~10km it stops being a selling point. */
const MAX_KM = Number(arg('max-km', 10));
/** Spacing along the centreline. 200m is finer than the 55m simplification error. */
const SAMPLE_M = Number(arg('sample-m', 200));
const MAX_SAMPLES = Number(arg('max-samples', 1200));
const ENDPOINT = arg('endpoint', osrm.DEFAULT_ENDPOINT);
/** Output file. Per-zone, so a zone sweep does not overwrite the previous zone. */
const OUT = arg('out', 'highway-entry.jsonl');

/**
 * Retry a database call.
 *
 * Present because the first run of this tool died on its very first query with
 * "Can't reach database server" — a transient pooler blip, minutes after the same
 * query had worked. Every other script in this repo wraps its DB calls for exactly
 * this reason; a read-only probe has no excuse to be the one that doesn't.
 */
async function withRetry(label, fn, attempts = 4) {
    for (let i = 1; ; i++) {
        try {
            return await fn();
        } catch (err) {
            if (i >= attempts) throw err;
            const wait = 1000 * 2 ** (i - 1);
            console.error(`  ${label} failed (${i}/${attempts}): ${String(err.message).split('\n')[0]} — retrying in ${wait}ms`);
            await new Promise((r) => setTimeout(r, wait));
        }
    }
}

/** Straight-line metres. Computed here so the winner's figure costs no round trip. */
function haversineM(a, b) {
    const R = 6371008.8;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** What OSRM actually matched a coordinate to, and how far it had to move it. */
async function nearestInfo(pt) {
    try {
        const res = await axios.get(
            `${ENDPOINT}/nearest/v1/driving/${pt.lng},${pt.lat}?number=1`,
            { timeout: 10000, validateStatus: () => true },
        );
        const wp = res.data && res.data.code === 'Ok' && res.data.waypoints && res.data.waypoints[0];
        return wp ? { snapM: wp.distance, name: wp.name || '' } : null;
    } catch (_) { return null; }
}

async function main() {
    if (!(await osrm.healthCheck({ endpoint: ENDPOINT }))) {
        console.error(`OSRM not answering at ${ENDPOINT}. Start it first.`);
        process.exit(2);
    }
    const prisma = new PrismaClient();
    const radius = Math.round(MAX_KM * 1000);

    const targets = await withRetry('targets', () => prisma.$queryRawUnsafe(`
        SELECT w.id, w.city, d.latitude AS lat, d.longitude AS lng
        FROM "Warehouse" w JOIN "WarehouseData" d ON d."warehouseId" = w.id
        WHERE d.latitude IS NOT NULL
          ${IDS.length ? `AND w.id IN (${IDS.join(',')})` : ''}
        ORDER BY w.id ${IDS.length ? '' : `LIMIT ${LIMIT}`}`));

    // Appended as each warehouse completes. The first version wrote the file only
    // at the end, which against tonight's intermittent pooler meant one refused
    // connection at warehouse 900 would discard 899 results.
    const outPath = path.isAbsolute(OUT) ? OUT : path.join(__dirname, OUT);
    const sink = fs.createWriteStream(outPath, { flags: 'w' });

    const results = [];
    for (const w of targets) {
        const T = { snap: 0, byLine: 0, samples: 0, route: 0, tagged: 0 };
        let t0 = Date.now();
        // Is this warehouse even inside the graph? Outside it, OSRM snaps to
        // whatever edge it has and returns confident nonsense.
        const originSnap = await nearestInfo({ lat: w.lat, lng: w.lng });
        T.snap = Date.now() - t0; t0 = Date.now();
        if (!originSnap || originSnap.snapM > 3000) continue;

        // (a) what the deck prints today: nearest by straight line
        const [byLine] = await withRetry(`byLine wh${w.id}`, () => prisma.$queryRawUnsafe(`
            WITH o AS (SELECT ST_SetSRID(ST_MakePoint(${w.lng}, ${w.lat}), 4326)::geography AS g)
            SELECT h.ref, h.highway, h.name,
                   ST_Distance(h.geog, o.g, false) AS "directM"
            FROM osm_highway h, o
            WHERE ST_DWithin(h.geog, o.g, ${radius}, false)
            ORDER BY h.geog <-> o.g
            LIMIT 1`));
        T.byLine = Date.now() - t0; t0 = Date.now();
        if (!byLine) continue;

        // (b) every numbered highway nearby, densified into candidate join points
        // TWO PASSES, BOUNDED BY THE ANSWER ITSELF.
        //
        // Sampling every highway inside a flat 10km box was both slow and wrong.
        // Slow because a dense city puts tens of thousands of vertices in the box
        // and Postgres segmentizes all of them before LIMIT truncates — measured
        // 10-16s per warehouse in Hyderabad. Wrong because dropping the ORDER BY
        // (to save the per-point geodetic distance) made that truncation
        // arbitrary: LIMIT would keep 2900 points from whichever ways the plan
        // emitted first, which can exclude the nearest highway outright. The
        // answers happened to match the slow version, which is luck, not method.
        //
        // The fix uses a property of the problem: road distance is never shorter
        // than straight-line distance. So once ANY highway has been routed to at
        // X km by road, no highway whose straight-line distance exceeds X can
        // possibly win, and the search radius collapses from a guessed 10km to a
        // proven X. Two passes, and the result is exact with no cap at all:
        //
        //   1. sample the single nearest way -> gives an upper bound X
        //   2. sample every way within X of the origin -> take the overall minimum
        //
        // X is typically under 3km, so pass 2 reads a fraction of the geometry.
        const DEG_STEP = SAMPLE_M / 111320;

        const sampleWithin = (km) => {
            const d = km / 100 + 0.002;   // degrees, with a small margin
            return withRetry(`samples wh${w.id} r=${km.toFixed(2)}`, () => prisma.$queryRawUnsafe(`
                WITH box AS (
                    SELECT ST_MakeEnvelope(${w.lng} - ${d}, ${w.lat} - ${d},
                                           ${w.lng} + ${d}, ${w.lat} + ${d}, 4326) AS b
                ), o AS (
                    SELECT ST_SetSRID(ST_MakePoint(${w.lng}, ${w.lat}), 4326)::geography AS g
                ), near AS (
                    SELECT h.id, h.ref, h.highway, h.name,
                           ST_Intersection(h.geog::geometry, (SELECT b FROM box)) AS g
                    FROM osm_highway h, o
                    WHERE h.geog && (SELECT b FROM box)::geography
                      AND ST_DWithin(h.geog, o.g, ${Math.round(km * 1000)}, false)
                )
                SELECT n.id, n.ref, n.highway, n.name,
                       ST_Y(p.geom) AS lat, ST_X(p.geom) AS lng
                FROM near n, LATERAL ST_DumpPoints(ST_Segmentize(n.g, ${DEG_STEP})) p
                WHERE NOT ST_IsEmpty(n.g)`));
        };

        const routeAll = async (pts) => {
            if (!pts.length) return [];
            const legs = await osrm.fetchLegsFrom(null, { lat: w.lat, lng: w.lng },
                pts.map((x) => ({ lat: x.lat, lng: x.lng })),
                { endpoint: ENDPOINT, maxTableCoords: 2900 });
            return pts.map((x, i) => ({
                ...x,
                km: legs[i] && legs[i].km,
                minutes: legs[i] && legs[i].minutes,
            })).filter((x) => Number.isFinite(x.km));
        };

        // Pass 1: the nearest way only, clipped tight around its closest approach.
        const firstRadius = Math.min(MAX_KM, Math.max(0.5, (byLine.directM / 1000) * 1.5 + 0.3));
        let samples = await sampleWithin(firstRadius);
        T.samples = Date.now() - t0; t0 = Date.now();

        let routed = await routeAll(samples);
        // Pass 2: widen to the proven bound, but only if it is wider than pass 1.
        if (routed.length) {
            const bound = Math.min(MAX_KM, Math.min(...routed.map((x) => x.km)));
            if (bound > firstRadius) {
                const more = await sampleWithin(bound);
                if (more.length > samples.length) {
                    samples = more;
                    routed = await routeAll(more);
                }
            }
        } else {
            // Nothing routable that close; fall back to the full radius once.
            samples = await sampleWithin(MAX_KM);
            routed = await routeAll(samples);
        }
        T.route = Date.now() - t0; t0 = Date.now();
        if (!samples.length) continue;

        if (!routed.length) continue;
        const win = routed.reduce((a, b) => (b.km < a.km ? b : a));
        const winSnap = await nearestInfo({ lat: win.lat, lng: win.lng });

        // (c) the tagged access points, routed the same way, to test whether the
        // ingest's 19,860 highway_access nodes could have answered this.
        const tagged = await withRetry(`tagged wh${w.id}`, () => prisma.$queryRawUnsafe(`
            WITH o AS (SELECT ST_SetSRID(ST_MakePoint(${w.lng}, ${w.lat}), 4326)::geography AS g)
            SELECT x.name, x.lat, x.lng,
                   ST_Distance(x.geog, o.g, false) AS "directM"
            FROM osm_poi x, o
            WHERE x.category = 'highway_access'
              AND ST_DWithin(x.geog, o.g, ${radius}, false)
            ORDER BY x.geog <-> o.g
            LIMIT 40`));
        let taggedKm = null;
        if (tagged.length) {
            const tl = await osrm.fetchLegsFrom(null, { lat: w.lat, lng: w.lng },
                tagged.map((t) => ({ lat: t.lat, lng: t.lng })), { endpoint: ENDPOINT });
            const ok = tl.map((l) => l && l.km).filter(Number.isFinite);
            if (ok.length) taggedKm = Math.min(...ok);
        }
        T.tagged = Date.now() - t0;

        // 99.4% of winners snap within 50m. Beyond that the sample landed on some
        // other road, so the number measures that road instead of the highway and
        // must not be reported as a highway distance.
        const snapSuspect = !winSnap || winSnap.snapM > 50;

        // How far the WAREHOUSE had to move to reach the road network, which is a
        // fact about the coordinate rather than about the highway.
        //
        // It is recorded and NOT added to roadKm. OSRM measures between snapped
        // endpoints, so the reported distance already starts from the nearest road
        // position — a reasonable proxy for the gate, since a warehouse pin
        // normally marks the compound or building centre. Adding the offset back
        // would double-count the yard.
        //
        // The exception is a large offset. Measured over 635 warehouses the snap
        // is a median 21m (p90 101m), which is compound-sized; but 10% exceed 100m
        // and the worst is 609m against a reported 1.01km. At that distance the pin
        // is not a compound centre — it is misplaced, or the site sits down a track
        // OSM does not have. Either way it belongs on the geocoding QA list beside
        // the city/state mismatches, not folded invisibly into a distance.
        const originSnapM = +originSnap.snapM.toFixed(1);
        const coordSuspect = originSnapM > 150;

        results.push({
            snapSuspect,
            coordSuspect,
            originSnapM,
            warehouseId: w.id,
            city: w.city,
            printedToday: { ref: byLine.ref || byLine.name, class: byLine.highway, directKm: +(byLine.directM / 1000).toFixed(2) },
            routed: {
                ref: win.ref || win.name,
                class: win.highway,
                // The osm_highway row that won, and the point on it where the
                // route joins. Recorded so a stored distance can be traced back to
                // its source and re-checked, and because "where do you get on"
                // is the answer a person actually wants to see on a map.
                highwayId: win.id,
                entryLat: +Number(win.lat).toFixed(6),
                entryLng: +Number(win.lng).toFixed(6),
                // Floored at 1: a 400m drive rounds to 0, and "0 min" reads as a
                // broken field. scripts/backfillHighwayEntry.js applies the same
                // floor on write, for JSONL produced before this line existed.
                driveMinutes: Number.isFinite(win.minutes)
                    ? Math.max(win.km > 0 ? 1 : 0, Math.round(win.minutes)) : null,
                roadKm: +win.km.toFixed(2),
                directKm: +(haversineM({ lat: w.lat, lng: w.lng }, win) / 1000).toFixed(2),
                snapM: winSnap ? +winSnap.snapM.toFixed(1) : null,
                snappedTo: winSnap ? winSnap.name : null,
            },
            detourRatio: +(win.km / (byLine.directM / 1000)).toFixed(2),
            refChanged: String(byLine.ref || '') !== String(win.ref || ''),
            taggedAccessKm: taggedKm === null ? null : +taggedKm.toFixed(2),
            samples: routed.length,
        });

        const r = results[results.length - 1];
        sink.write(JSON.stringify(r) + '\n');
        console.log(`wh${String(w.id).padEnd(6)}${String(w.city || '').slice(0, 16).padEnd(17)}`
            + `line ${String(r.printedToday.ref).padEnd(8)} ${String(r.printedToday.directKm).padStart(6)}km   `
            + `road ${String(r.routed.ref).padEnd(8)} ${String(r.routed.roadKm).padStart(6)}km  `
            + `x${r.detourRatio}  snap ${r.routed.snapM}m  ${r.refChanged ? 'REF CHANGED' : ''}`
            + `${r.taggedAccessKm !== null ? `  tagged=${r.taggedAccessKm}km` : '  tagged=none'}`
            + `  [${r.samples}pts snap${T.snap} line${T.byLine} sql${T.samples} route${T.route} tag${T.tagged}ms]`);
    }

    // --- Summary -----------------------------------------------------------
    console.log(`\n=== ${results.length} warehouses ===`);
    const ratios = results.map((r) => r.detourRatio);
    const snaps = results.map((r) => r.routed.snapM).filter(Number.isFinite);
    console.log(`  road/straight-line ratio    median ${median(ratios)}, max ${Math.max(...ratios)}`);
    console.log(`  winning sample snap dist    median ${median(snaps)}m, max ${Math.max(...snaps)}m`);
    console.log(`  designation changed         ${results.filter((r) => r.refChanged).length}/${results.length}`);

    const withTagged = results.filter((r) => r.taggedAccessKm !== null);
    console.log(`  tagged access available     ${withTagged.length}/${results.length}`);
    if (withTagged.length) {
        const over = withTagged.map((r) => +(r.taggedAccessKm - r.routed.roadKm).toFixed(2));
        console.log(`  tagged access overstates by median ${median(over)}km, max ${Math.max(...over)}km`);
    }

    const suspect = results.filter((r) => r.snapSuspect).length;
    console.log(`  winner snapped >50m        ${suspect}/${results.length} — not usable as a highway distance`);
    const coord = results.filter((r) => r.coordSuspect).length;
    console.log(`  warehouse >150m from road  ${coord}/${results.length} — coordinate quality, for QA`);

    sink.end();
    console.log(`\n  written to ${outPath}`);
    await prisma.$disconnect();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
