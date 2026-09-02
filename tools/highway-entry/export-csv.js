/**
 * Turn the probe's JSONL into two CSVs a person can act on.
 *
 *   highway-entry.csv   the measured drive distance to the nearest numbered
 *                       highway, per warehouse — the number a deck would print.
 *   coord-suspects.csv  warehouses whose pin sits >150m from any road. These are
 *                       a COORDINATE problem, not a highway one, and belong with
 *                       the city/state mismatches the QA team already has.
 *
 * Quoting is RFC 4180. Not optional: Indian road names carry commas
 * ("Malur - Hosur - Adhiyamankottai Road") and place names carry both commas and
 * the occasional quote, and a CSV that only looks right in a text editor fails in
 * the spreadsheet it was made for.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const write = (file, cols, rows) => {
    fs.writeFileSync(file,
        [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n');
    console.log(`  ${rows.length} rows -> ${file}`);
};

(async () => {
    const inPath = process.argv[2] || path.join(__dirname, 'highway-entry.jsonl');
    const rows = fs.readFileSync(inPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const prisma = new PrismaClient();
    const meta = await prisma.$queryRawUnsafe(`
        SELECT w.id, w.city, w.state, w."uploadedBy" AS uploader,
               d.latitude AS lat, d.longitude AS lng
        FROM "Warehouse" w JOIN "WarehouseData" d ON d."warehouseId" = w.id
        WHERE w.id IN (${rows.map((r) => r.warehouseId).join(',')})`);
    const by = Object.fromEntries(meta.map((m) => [m.id, m]));

    // Backfill the warehouse's offset from the road network for rows written
    // before the probe recorded it. Asking OSRM is cheap and local, and it keeps
    // one exporter valid for every run rather than leaving the earliest and
    // largest batch missing the column that flags bad pins.
    const axios = require('axios');
    const endpoint = process.env.OSRM_ENDPOINT || 'http://localhost:5000';
    const missing = rows.filter((r) => r.originSnapM === undefined);
    if (missing.length) {
        console.log(`  backfilling warehouse road offset for ${missing.length} rows...`);
        let failed = 0;
        for (const r of missing) {
            const m = by[r.warehouseId];
            if (!m || m.lat === null) { failed += 1; continue; }
            try {
                const res = await axios.get(
                    `${endpoint}/nearest/v1/driving/${m.lng},${m.lat}?number=1`,
                    { timeout: 8000, validateStatus: () => true },
                );
                const wp = res.data && res.data.code === 'Ok' && res.data.waypoints && res.data.waypoints[0];
                if (wp && Number.isFinite(wp.distance)) {
                    r.originSnapM = +wp.distance.toFixed(1);
                    r.coordSuspect = r.originSnapM > 150;
                } else { failed += 1; }
            } catch (_) { failed += 1; }
        }
        // Said out loud rather than left as blank cells: a blank in this column
        // must not be read as "the pin is fine".
        if (failed) console.log(`  WARNING: ${failed} rows have no offset — blank there means UNKNOWN, not OK`);
    }

    const main = rows.map((r) => {
        const m = by[r.warehouseId] || {};
        return {
            warehouse_id: r.warehouseId,
            city: m.city || '',
            state: m.state || '',
            nearest_highway: r.routed.ref || '',
            highway_class: r.routed.class || '',
            drive_km_to_highway: r.routed.roadKm,
            straight_line_km: r.printedToday.directKm,
            extra_km_vs_straight_line: +(r.routed.roadKm - r.printedToday.directKm).toFixed(2),
            // Where the two disagree the deck currently prints the wrong road.
            designation_printed_today: r.printedToday.ref || '',
            designation_changed: r.refChanged ? 'YES' : '',
            samples_routed: r.samples,
            entry_snap_m: r.routed.snapM,
            warehouse_offset_from_road_m: r.originSnapM === undefined ? '' : r.originSnapM,
            coordinate_suspect: r.coordSuspect ? 'YES' : '',
            map_link: m.lat ? `https://www.google.com/maps?q=${m.lat},${m.lng}` : '',
        };
    }).sort((a, b) => b.drive_km_to_highway - a.drive_km_to_highway);

    write(path.join(__dirname, 'highway-entry.csv'), Object.keys(main[0]), main);

    const suspects = rows.filter((r) => r.coordSuspect).map((r) => {
        const m = by[r.warehouseId] || {};
        return {
            warehouse_id: r.warehouseId,
            city_state: [m.city, m.state].filter(Boolean).join(', '),
            metres_from_nearest_road: r.originSnapM,
            why: 'The stored coordinate is further from any road than a compound could account for. '
                + 'Either the pin is misplaced, or the site is down an access track OSM does not have. '
                + 'Until it is confirmed, its highway distance is measured from wherever the router '
                + 'put it rather than from the property.',
            added_by: m.uploader || '(not recorded)',
            map_link: m.lat ? `https://www.google.com/maps?q=${m.lat},${m.lng}` : '',
        };
    }).sort((a, b) => b.metres_from_nearest_road - a.metres_from_nearest_road);

    if (suspects.length) {
        write(path.join(__dirname, 'coord-suspects.csv'), Object.keys(suspects[0]), suspects);
    } else {
        console.log('  no coordinate suspects (the run predates the originSnapM field)');
    }
    await prisma.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
