/**
 * Repair warehouse coordinates that captured a Google Maps VIEWPORT instead of a pin.
 *
 * THE DEFECT. A `/maps/place/…` URL carries two coordinate pairs: `!3d/!4d` is the
 * place, and `@lat,lng,<zoom>z` is wherever the map viewport happened to be
 * centred. Whatever extracted these records took the `@` segment. At low zoom the
 * viewport centre is nowhere near the pin — warehouse 2038 was stored 50km out in
 * the Arabian Sea, and its connectivity slide rendered a map of open water with
 * nine distances measured from it.
 *
 * (The dashboard's own parser had the same preference until this was found. See
 * Frontend_Repository/src/utils/latLngInput.js.)
 *
 * WHAT IT WILL AND WILL NOT TOUCH. A coordinate is customer data and a wrong
 * "correction" is worse than a known-bad value, so a row is only rewritten when
 * every one of these holds:
 *
 *   1. the resolved URL contains a place (`!3d/!4d`);
 *   2. the STORED point sits within 50m of that URL's `@` segment — the signature
 *      of the defect, rather than merely a coordinate that disagrees with a link;
 *   3. the place is more than MIN_GAP_M from the stored point, so we are not
 *      churning rows over rounding;
 *   4. the place reverse-geocodes to the SAME STATE as the warehouse record. A link
 *      can legitimately point somewhere else entirely — a scout pasting the wrong
 *      thing — and following it blindly would replace one wrong coordinate with a
 *      different wrong coordinate.
 *
 * Anything failing (4) is reported for a human rather than skipped silently: a link
 * disagreeing with its own record is itself a finding.
 *
 * Every change is written to a JSON audit file before the update runs, because
 * WarehouseData has no history and the old value is otherwise unrecoverable.
 *
 * Usage:
 *   node -r dotenv/config scripts/fixViewportCoordinates.js --in=/tmp/farpin-resolved.json
 *   node -r dotenv/config scripts/fixViewportCoordinates.js --in=... --apply
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');

const arg = (n, d) => {
    const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.split('=').slice(1).join('=') : d;
};
const APPLY = process.argv.includes('--apply');
const IN = arg('in', '/tmp/farpin-resolved.json');
/** Below this the two points are effectively the same place; not worth a write. */
const MIN_GAP_M = Number(arg('min-gap-m', 500));

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
/** Renamed states, so a rename is not read as a mismatch. */
const STATE_ALIASES = [['orissa', 'odisha'], ['pondicherry', 'puducherry'],
    ['uttaranchal', 'uttarakhand'], ['nctofdelhi', 'delhi']];
const sameState = (a, b) => {
    const x = norm(a); const y = norm(b);
    if (!x || !y) return false;
    if (x === y || x.includes(y) || y.includes(x)) return true;
    return STATE_ALIASES.some(([p, q]) => (x.includes(p) && y.includes(q)) || (x.includes(q) && y.includes(p)));
};

async function regionOf(lat, lng, token) {
    const url = 'https://api.mapbox.com/search/geocode/v6/reverse'
        + `?longitude=${lng}&latitude=${lat}&types=region&access_token=${token}`;
    try {
        const { data } = await axios.get(url, { timeout: 20000 });
        const f = (data.features || [])[0];
        return (f && f.properties && f.properties.name) || '';
    } catch (_) { return ''; }
}

function scriptClient() {
    const url = process.env.DATABASE_URL || '';
    return new PrismaClient({
        datasources: { db: { url: url.replace(/connection_limit=\d+/, 'connection_limit=1') } },
    });
}

(async () => {
    const resolved = JSON.parse(fs.readFileSync(IN, 'utf8'));
    const prisma = scriptClient();
    const token = process.env.MAPBOX_ACCESS_TOKEN;

    const meta = Object.fromEntries((await prisma.$queryRawUnsafe(
        `SELECT w.id, w.city, w.state, d.latitude lat, d.longitude lng
         FROM "Warehouse" w JOIN "WarehouseData" d ON d."warehouseId" = w.id
         WHERE w.id IN (${resolved.map((r) => r.id).join(',')})`,
    )).map((m) => [m.id, m]));

    const candidates = resolved.filter((r) => r.matchesAtSegment === true && r.gapToPlaceM > MIN_GAP_M);
    console.log(`${resolved.length} resolved, ${candidates.length} carry the viewport signature`);

    const fix = [];
    const review = [];
    for (const c of candidates) {
        const m = meta[c.id];
        if (!m) continue;
        const region = await regionOf(c.place[0], c.place[1], token);
        const entry = {
            id: c.id, city: m.city, state: m.state,
            from: [m.lat, m.lng], to: c.place,
            gapKm: +(c.gapToPlaceM / 1000).toFixed(2),
            placeRegion: region,
        };
        if (sameState(m.state, region)) fix.push(entry);
        else review.push(entry);
    }

    console.log(`  safe to correct (link's place is in the recorded state): ${fix.length}`);
    console.log(`  needs a human (link points to a different state)      : ${review.length}`);
    for (const r of review) {
        console.log(`     wh${String(r.id).padEnd(6)} record says ${r.state}, link resolves to ${r.placeRegion || '(nowhere)'} — ${r.gapKm} km away`);
    }

    const audit = path.join(__dirname, '..', 'tools', 'highway-entry', 'coordinate-fixes.json');
    fs.writeFileSync(audit, JSON.stringify({ when: new Date().toISOString(), fix, review }, null, 1));
    console.log(`\n  audit written to ${audit}`);

    if (!APPLY) {
        console.log('  --dry run: nothing written. Re-run with --apply to correct them.');
        for (const f of fix.slice(0, 10)) {
            console.log(`     wh${String(f.id).padEnd(6)} ${f.city}: ${f.from.join(', ')} -> ${f.to.join(', ')}  (${f.gapKm} km)`);
        }
        await prisma.$disconnect();
        return;
    }

    let done = 0;
    for (const f of fix) {
        // geog is GENERATED ALWAYS from these columns, so it follows automatically,
        // and computedFromLat/Lng on warehouse_proximity stops matching — which is
        // what marks the derived rows stale, with no hook and no trigger.
        done += await prisma.$executeRawUnsafe(
            'UPDATE "WarehouseData" SET latitude = $1, longitude = $2 WHERE "warehouseId" = $3',
            f.to[0], f.to[1], f.id,
        );
    }
    console.log(`\n  corrected ${done} coordinates`);

    const stale = await prisma.$queryRawUnsafe(`
        SELECT count(*)::int n FROM warehouse_proximity x
        JOIN "WarehouseData" d ON d."warehouseId" = x."warehouseId"
        WHERE x."warehouseId" IN (${fix.map((f) => f.id).join(',') || '0'})
          AND (x."computedFromLat" IS DISTINCT FROM d.latitude
            OR x."computedFromLng" IS DISTINCT FROM d.longitude)`);
    console.log(`  proximity rows now stale and needing recompute: ${stale[0].n}`);
    await prisma.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
