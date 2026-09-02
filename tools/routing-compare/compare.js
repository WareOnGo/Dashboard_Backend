/**
 * Local OSRM against the stored Mapbox baseline.
 *
 * THE POINT OF THIS TOOL IS THAT IT CHANGES ONE VARIABLE AT A TIME. The obvious
 * comparison — "what did Mapbox say, what does OSRM say" — moves two things at
 * once (a different engine AND a different candidate set), and a single combined
 * number cannot tell you which one mattered. That mistake was already made once
 * in this work, with a "42-67% divergence" figure taken from five legs that
 * turned out to be 1.3% median across 218. So:
 *
 *   METHOD  (engine held constant): OSRM's winner over EVERY candidate in radius,
 *           versus OSRM's winner over just the k=20 shortlist the backfill draws.
 *           Any gap here is the shortlist being wrong, measured against ground
 *           truth rather than against another approximation. This is the number
 *           that justifies — or retires — the whole shortlist apparatus.
 *
 *   ENGINE  (candidate held constant): for the SAME landmark Mapbox chose, how
 *           far apart are the two distances. This is a different map vintage, a
 *           different traffic model and different snapping, so a gap here is not
 *           an error in either — it is the price of switching.
 *
 * Only the first is a correctness claim. The second is a compatibility claim, and
 * it decides whether numbers already sent to clients would move if we switched.
 *
 * Usage: node -r dotenv/config tools/routing-compare/compare.js [--limit=150]
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const osrm = require('../../src/utils/osrmRouting');
const { guardCandidates, MAX_DIRECT_RATIO } = require('../../src/utils/proximityShortlist');
const categories = require('../../src/utils/proximityCategories');

const arg = (name, dflt) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : dflt;
};

const LIMIT = Number(arg('limit', 150));
/** Specific warehouses, for validating the tool against sites you know by eye. */
const IDS = (arg('ids', '') || '').split(',').map((x) => Number(x.trim())).filter(Boolean);
/**
 * Candidates fetched per category. "Ground truth" that silently dropped the
 * next candidate would be another approximation wearing the word truth, so this
 * is set high enough not to bind and the run reports it per category if it ever
 * does. MEASURED on five Bengaluru warehouses: hospital returns up to 613 inside
 * 25km, so the first value here (400) would have truncated the single densest
 * category on three of the five — quietly, and in the direction of agreeing with
 * the shortlist it exists to judge. Locally a leg costs nothing, so there is no
 * reason to economise.
 */
const MAX_CANDIDATES = Number(arg('max-candidates', 2000));
const ENDPOINT = arg('endpoint', osrm.DEFAULT_ENDPOINT);
/**
 * Optional coarse pre-filter. NOT the coverage test — see snapDistanceM below.
 *
 * A declared bounding box is not a coverage test, which the southern-zone extract
 * demonstrates: its header box is (70.00,5.94)-(95.56,19.92), stretching east to
 * the Andamans and north past latitude 19.9. Mumbai sits at 19.07N,72.8E — inside
 * that box, and entirely absent from the extract, which stops at the western
 * zone's border. Filtering on the box would have quietly admitted every Mumbai
 * warehouse as "covered".
 *
 * Format: --bbox=minLng,minLat,maxLng,maxLat. Useful only to cut query volume.
 */
const BBOX = (() => {
    const raw = arg('bbox', '');
    if (!raw) return null;
    const p = raw.split(',').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) {
        console.error('--bbox needs four numbers: minLng,minLat,maxLng,maxLat');
        process.exit(2);
    }
    return { minLng: p[0], minLat: p[1], maxLng: p[2], maxLat: p[3] };
})();

// The module's own helper, not a local filter on `metric`: a hand-written
// string test here silently included national_highway when it compared against
// 'IDENTITY' and the value is 'identity'. That category is a LINE in
// osm_highway, so it would have queried osm_poi for a category that has no rows
// there and reported a clean zero.
const ROAD = categories.routedCategories();

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');
const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs, q) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/**
 * How far OSRM had to move a point to put it on the road network.
 *
 * This is the honest coverage test, and it is needed because OSRM never says
 * "that is outside my data". Given a point beyond the extract it snaps to the
 * nearest edge it does have — possibly hundreds of km away — and then returns
 * perfectly well-formed distances measured from there. Those are not nulls that a
 * filter would catch; they are plausible numbers about the wrong place.
 *
 * @returns {number|null} metres, or null if OSRM would not answer
 */
async function snapDistanceM(point, endpoint) {
    const axios = require('axios');
    try {
        const res = await axios.get(
            `${endpoint}/nearest/v1/driving/${point.lng},${point.lat}?number=1`,
            { timeout: 10000, validateStatus: () => true },
        );
        const wp = res.data && res.data.code === 'Ok' && res.data.waypoints && res.data.waypoints[0];
        return wp && Number.isFinite(wp.distance) ? wp.distance : null;
    } catch (_) {
        return null;
    }
}

/** Beyond this, treat the warehouse as outside the graph rather than as data. */
const MAX_SNAP_M = Number(arg('max-snap-m', 3000));

async function main() {
    if (!(await osrm.healthCheck({ endpoint: ENDPOINT }))) {
        console.error(`OSRM is not answering at ${ENDPOINT}.`);
        console.error('Start it with ~/dev/wareongo/osrm-india/build-osrm.sh, then re-run.');
        process.exit(2);
    }
    console.log(`OSRM up at ${ENDPOINT}\n`);

    const prisma = new PrismaClient();

    // Warehouses that already carry a Mapbox baseline, so every comparison has
    // something to compare against.
    const targets = await prisma.$queryRawUnsafe(`
        SELECT w.id, d.latitude AS lat, d.longitude AS lng
        FROM "Warehouse" w
        JOIN "WarehouseData" d ON d."warehouseId" = w.id
        WHERE d.latitude IS NOT NULL
          AND EXISTS (SELECT 1 FROM warehouse_proximity p
                      WHERE p."warehouseId" = w.id AND p.status = 'OK')
          ${IDS.length ? `AND w.id IN (${IDS.join(',')})` : ''}
          ${BBOX ? `AND d.longitude BETWEEN ${BBOX.minLng} AND ${BBOX.maxLng}
                    AND d.latitude  BETWEEN ${BBOX.minLat} AND ${BBOX.maxLat}` : ''}
        ORDER BY w.id
        LIMIT ${LIMIT}`);
    if (BBOX) {
        const [{ n }] = await prisma.$queryRawUnsafe(`
            SELECT count(*)::int AS n FROM "Warehouse" w
            JOIN "WarehouseData" d ON d."warehouseId" = w.id
            WHERE d.latitude IS NOT NULL
              AND EXISTS (SELECT 1 FROM warehouse_proximity p
                          WHERE p."warehouseId" = w.id AND p.status = 'OK')`);
        console.log(`bbox limits this to the graph's coverage: ${targets.length} of ${n} baselined warehouses`);
    }
    console.log(`${targets.length} warehouses with a Mapbox baseline\n`);

    const values = ROAD.map((c) => `('${c.key}', ${Math.round(c.maxRadiusKm * 1000)})`).join(', ');
    const stats = {
        method: { compared: 0, differs: 0, penaltyKm: [], byCategory: {} },
        engine: { compared: 0, ratios: [], within5: 0, within10: 0 },
        capped: {},
        unroutable: 0,
        legs: 0,
    };
    const disagreements = [];
    const allEngine = [];

    let outsideGraph = 0;
    for (const w of targets) {
        const snap = await snapDistanceM({ lat: w.lat, lng: w.lng }, ENDPOINT);
        if (snap === null || snap > MAX_SNAP_M) {
            outsideGraph += 1;
            continue;
        }

        const candidates = await prisma.$queryRawUnsafe(`
            WITH origin AS (
                SELECT ST_SetSRID(ST_MakePoint(${w.lng}, ${w.lat}), 4326)::geography AS g
            ), spec AS (
                SELECT * FROM (VALUES ${values}) AS t(category, radius_m)
            )
            SELECT s.category, p.id AS "poiId", p.name, p.lat, p.lng, p."directM"
            FROM origin o
            CROSS JOIN spec s
            CROSS JOIN LATERAL (
                SELECT x.id, x.name, x.lat, x.lng,
                       ST_Distance(x.geog, o.g, false) AS "directM"
                FROM osm_poi x
                WHERE x.category = s.category
                  AND ST_DWithin(x.geog, o.g, s.radius_m, false)
                ORDER BY x.geog <-> o.g
                LIMIT ${MAX_CANDIDATES}
            ) p
            ORDER BY s.category, p."directM"`);

        if (!candidates.length) continue;

        const stored = await prisma.warehouseProximity.findMany({
            where: { warehouseId: w.id, status: 'OK' },
        });
        const storedBy = Object.fromEntries(stored.map((r) => [r.category, r]));

        // One /table call for every candidate of every category. This is the
        // thing Mapbox cannot do at any sane price and the reason to host locally.
        let legs;
        try {
            legs = await osrm.fetchLegsFrom(null, { lat: w.lat, lng: w.lng },
                candidates.map((c) => ({ lat: c.lat, lng: c.lng })), { endpoint: ENDPOINT });
        } catch (err) {
            console.error(`  warehouse ${w.id}: OSRM unavailable mid-run — ${err.message}`);
            break;
        }
        stats.legs += candidates.length;
        candidates.forEach((c, i) => { c.leg = legs[i]; });

        for (const cat of ROAD) {
            const mine = candidates.filter((c) => c.category === cat.key);
            if (!mine.length) continue;
            if (mine.length >= MAX_CANDIDATES) {
                stats.capped[cat.key] = (stats.capped[cat.key] || 0) + 1;
            }

            const routed = mine.filter((c) => c.leg && Number.isFinite(c.leg.km));
            if (!routed.length) { stats.unroutable += 1; continue; }

            // --- METHOD: ground truth vs the shortlist, same engine ----------
            const truth = routed.reduce((a, b) => (b.leg.km < a.leg.km ? b : a));

            // Passed through as-is: guardCandidates reads directM, lat and lng, all
            // of which the query already returns, and it requires ascending directM
            // order — which the ORDER BY provides.
            const shortlisted = guardCandidates(mine.slice(0, cat.candidates), MAX_DIRECT_RATIO)
                .filter((c) => c.leg && Number.isFinite(c.leg.km));
            const pick = shortlisted.length
                ? shortlisted.reduce((a, b) => (b.leg.km < a.leg.km ? b : a))
                : null;

            if (pick) {
                stats.method.compared += 1;
                const bucket = stats.method.byCategory[cat.key]
                    || (stats.method.byCategory[cat.key] = { n: 0, differs: 0 });
                bucket.n += 1;
                if (String(pick.poiId) !== String(truth.poiId)) {
                    stats.method.differs += 1;
                    bucket.differs += 1;
                    const penalty = pick.leg.km - truth.leg.km;
                    stats.method.penaltyKm.push(penalty);
                    disagreements.push({
                        kind: 'METHOD',
                        warehouseId: w.id,
                        category: cat.key,
                        shortlistPick: { name: pick.name, km: +pick.leg.km.toFixed(2), directKm: +(pick.directM / 1000).toFixed(2) },
                        truth: { name: truth.name, km: +truth.leg.km.toFixed(2), directKm: +(truth.directM / 1000).toFixed(2) },
                        // Where in the crow-flies ordering the real winner sat. A
                        // rank beyond cat.candidates means no k would have found it.
                        truthRankByDirect: mine.findIndex((c) => String(c.poiId) === String(truth.poiId)) + 1,
                        penaltyKm: +penalty.toFixed(2),
                        candidatesInRadius: mine.length,
                    });
                }
            }

            // --- ENGINE: same landmark, two engines --------------------------
            const base = storedBy[cat.key];
            if (base && base.poiId && Number.isFinite(base.roadKm)) {
                const same = mine.find((c) => String(c.poiId) === String(base.poiId));
                if (same && same.leg && Number.isFinite(same.leg.km) && base.roadKm > 0) {
                    const ratio = same.leg.km / base.roadKm;
                    stats.engine.compared += 1;
                    stats.engine.ratios.push(ratio);
                    if (Math.abs(ratio - 1) <= 0.05) stats.engine.within5 += 1;
                    if (Math.abs(ratio - 1) <= 0.10) stats.engine.within10 += 1;
                    // Every engine comparison, not just the loud ones. The
                    // interesting structure turned out to be per-ORIGIN rather
                    // than per-leg, and that is invisible if only outliers are
                    // recorded.
                    allEngine.push({
                        warehouseId: w.id,
                        category: cat.key,
                        landmark: base.landmarkName,
                        mapboxKm: base.roadKm,
                        osrmKm: +same.leg.km.toFixed(2),
                        diffKm: +(base.roadKm - same.leg.km).toFixed(2),
                        ratio: +ratio.toFixed(3),
                    });
                    if (Math.abs(ratio - 1) > 0.25) {
                        disagreements.push({
                            kind: 'ENGINE',
                            warehouseId: w.id,
                            category: cat.key,
                            landmark: base.landmarkName,
                            mapboxKm: base.roadKm,
                            osrmKm: +same.leg.km.toFixed(2),
                            ratio: +ratio.toFixed(3),
                        });
                    }
                }
            }
        }
    }

    // --- Report -------------------------------------------------------------
    const m = stats.method;
    const e = stats.engine;
    console.log('=== METHOD: does the k=%d shortlist find the true nearest? ===', ROAD[0].candidates);
    console.log(`  comparisons                 ${m.compared}`);
    console.log(`  shortlist named a different landmark   ${m.differs}  (${pct(m.differs, m.compared)})`);
    if (m.penaltyKm.length) {
        console.log(`  when it differed, extra km  median ${median(m.penaltyKm).toFixed(2)}, p90 ${quantile(m.penaltyKm, 0.9).toFixed(2)}, max ${Math.max(...m.penaltyKm).toFixed(2)}`);
    }
    for (const [k, v] of Object.entries(m.byCategory).sort((a, b) => b[1].differs - a[1].differs)) {
        if (v.differs) console.log(`    ${k.padEnd(18)}${v.differs}/${v.n} (${pct(v.differs, v.n)})`);
    }

    console.log('\n=== ENGINE: same landmark, OSRM vs Mapbox ===');
    console.log(`  comparisons                 ${e.compared}`);
    if (e.ratios.length) {
        console.log(`  osrm/mapbox ratio           median ${median(e.ratios).toFixed(3)}, p10 ${quantile(e.ratios, 0.1).toFixed(3)}, p90 ${quantile(e.ratios, 0.9).toFixed(3)}`);
        console.log(`  agree within 5% / 10%       ${pct(e.within5, e.compared)} / ${pct(e.within10, e.compared)}`);
    }

    if (outsideGraph) {
        console.log(`\n  skipped: outside the graph  ${outsideGraph} warehouses (origin snapped >${MAX_SNAP_M}m or not at all)`);
    }
    console.log(`\n  legs routed locally         ${stats.legs} (free; the same run on Mapbox would be ${stats.legs} paid requests)`);
    if (stats.unroutable) console.log(`  categories with nothing routable  ${stats.unroutable}`);
    for (const [k, v] of Object.entries(stats.capped)) {
        console.log(`  CAPPED at ${MAX_CANDIDATES} candidates: ${k} on ${v} warehouses — truth may be understated`);
    }

    // Divergence BY CATEGORY, which is where the structure actually lives.
    //
    // An earlier cut of this looked for a constant per-warehouse offset, on the
    // theory that the two engines snap the origin to different roads. The data
    // refuted it: warehouse 995's fuel and police legs agree to within 0.05km
    // while its hospital, railway, city-centre and bus legs are all longer by
    // exactly 2.33km. Origin snapping would tax every leg equally. What those
    // four share is a DIRECTION — every one of them is down the Anekal corridor —
    // so the two maps disagree about one road segment, and every destination
    // beyond it inherits the same constant. Warehouse 2186 shows the same shape
    // with its two Whitefield legs at +4.1km.
    //
    // The useful consequence: divergence tracks how FAR the leg is, because a
    // longer route crosses more chances to disagree. Reported per category, since
    // that is what a deck actually prints.
    const byCat = {};
    for (const r of allEngine) (byCat[r.category] ||= []).push(r);
    console.log('\n=== DIVERGENCE BY CATEGORY: which printed numbers would move? ===');
    console.log('  category           n   median km    median ratio   within 0.5km');
    const catRows = Object.entries(byCat).map(([k, rs]) => {
        const absDiffs = rs.map((r) => Math.abs(r.diffKm));
        const tight = rs.filter((r) => Math.abs(r.diffKm) <= 0.5).length;
        return {
            k,
            n: rs.length,
            medDiff: median(absDiffs),
            medRatio: median(rs.map((r) => r.ratio)),
            tight: tight / rs.length,
            medMapbox: median(rs.map((r) => r.mapboxKm)),
        };
    }).sort((a, b) => a.medMapbox - b.medMapbox);
    for (const r of catRows) {
        console.log(`  ${r.k.padEnd(17)}${String(r.n).padStart(3)}${r.medDiff.toFixed(2).padStart(11)}${r.medRatio.toFixed(3).padStart(15)}${(r.tight * 100).toFixed(0).padStart(14)}%`);
    }

    fs.writeFileSync(path.join(__dirname, 'all-engine-legs.jsonl'),
        allEngine.map((d) => JSON.stringify(d)).join('\n') + '\n');

    const out = path.join(__dirname, 'disagreements.jsonl');
    fs.writeFileSync(out, disagreements.map((d) => JSON.stringify(d)).join('\n') + '\n');
    console.log(`\n  ${disagreements.length} disagreements written to ${out}`);

    await prisma.$disconnect();
}

if (require.main === module) {
    main().catch((e) => { console.error(e); process.exit(1); });
}
