const axios = require('axios');
const { LAYOUT, COLORS, FONT, FONT_SEMIBOLD, addSlideTitle } = require('./layoutV3');
const { addFooter, addTopRightLogo } = require('../v2/chromeV2');
const { logInfo, logWarn } = require('../../utils/logger');
const {
    CATEGORIES, METRIC_IDENTITY,
} = require('../../../utils/proximityCategories');
const { STATUS, WARNING } = require('../../../utils/proximityShortlist');

/**
 * One slide per warehouse: a street map of the site on the left, its distances to
 * nearby landmarks on the right.
 *
 * The numbers are READ, not computed. Every value comes from warehouse_proximity,
 * filled once by scripts/backfillWarehouseProximity.js, so this slide makes no
 * routing call and adds nothing to export time beyond fetching one map image. That
 * is the whole point of the precompute: the `detailed` deck calls Overpass and
 * Nominatim live, per warehouse, per export, and hangs when a volunteer-run server
 * is slow.
 *
 * NO ROUTE LINES on the map, by request. The overview and client-distance slides
 * draw them because a route between two named points is the subject there. Here the
 * subject is the site itself, and nine routes radiating from it would obscure the
 * streets a reader is actually trying to see.
 */

/** Street style: a reader is orienting themselves, so roads and names matter more than terrain. */
const STYLE = 'streets-v12';

/**
 * Zoom 13 shows roughly a 5km span at this image size — close enough to read the
 * surrounding road network, wide enough to place the site in its area. Fixed rather
 * than fitted, so every warehouse in a deck is shown at the same scale and the
 * slides are comparable.
 */
const ZOOM = 13;

const PIN_COLOR = COLORS.navy.replace('#', '');
const TIMEOUT_MS = 8000;

/**
 * Longest landmark name shown in full.
 *
 * Was 32, which cut "Navi Mumbai International Airport" and "Shree Siddhakala
 * General Hospital" mid-word — the two cases where the name matters most. With the
 * section headings gone the label column is wider and the rows taller, so a longer
 * name fits without crowding.
 */
const NAME_MAX = 46;

/** Map column width. The table needs less room than the map, so it gets less. */
const MAP_W = 4.55;

/** Requested at 2x for a retina-sharp image; sized to the column's aspect ratio. */
const IMAGE_W = 900;
const IMAGE_H = Math.round(IMAGE_W / (MAP_W / LAYOUT.CONTENT_H));

const num = (v) => (typeof v === 'number' ? v : Number(v));
const hasCoords = (w) => {
    const d = w && w.WarehouseData;
    return !!d && Number.isFinite(num(d.latitude)) && Number.isFinite(num(d.longitude));
};

/**
 * A street map centred on one warehouse.
 *
 * Never throws and never rejects: a missing map costs the slide its left half, and
 * that is a far better outcome than losing the deck.
 */
async function fetchSiteMap(warehouse, flags = {}) {
    if (flags.mapsLocation === false) return null;
    if (!hasCoords(warehouse)) return null;

    const token = process.env.MAPBOX_ACCESS_TOKEN;
    if (!token) return null;

    const lat = num(warehouse.WarehouseData.latitude);
    const lng = num(warehouse.WarehouseData.longitude);
    const pin = `pin-l+${PIN_COLOR}(${lng.toFixed(5)},${lat.toFixed(5)})`;
    const url = `https://api.mapbox.com/styles/v1/mapbox/${STYLE}/static/${pin}`
        + `/${lng.toFixed(5)},${lat.toFixed(5)},${ZOOM}/${IMAGE_W}x${IMAGE_H}@2x`
        + `?access_token=${token}`;

    try {
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: TIMEOUT_MS });
        return `image/png;base64,${Buffer.from(res.data).toString('base64')}`;
    } catch (_) {
        return null;
    }
}

/**
 * Fetch every site map for a deck at once.
 *
 * Started before the deck is drawn and awaited when the slides are built, so the
 * images download while the photographs do rather than after them.
 *
 * @returns {Promise<Map<number, string>>} warehouse id -> data URI
 */
async function fetchSiteMaps(warehouses, flags = {}) {
    const withCoords = (warehouses || []).filter(hasCoords);
    if (!withCoords.length) return new Map();

    const startedAt = Date.now();
    const images = await Promise.all(withCoords.map((w) => fetchSiteMap(w, flags)));
    const out = new Map();
    withCoords.forEach((w, i) => { if (images[i]) out.set(w.id, images[i]); });

    logInfo('proximitySlideV3', 'fetchSiteMaps', 'Site maps ready', {
        requested: withCoords.length, fetched: out.size, durationMs: Date.now() - startedAt,
    });
    return out;
}

const fmtKm = (km) => {
    if (km === null || km === undefined) return null;
    const n = num(km);
    if (!Number.isFinite(n)) return null;
    // Under a kilometre, metres read better than "0.4 km"; above ten, decimals are noise.
    if (n < 1) return `${Math.round(n * 1000)} m`;
    return `${n < 10 ? n.toFixed(1) : Math.round(n)} km`;
};

const fmtMin = (m) => {
    if (m === null || m === undefined) return null;
    const mins = Math.round(num(m));
    if (!Number.isFinite(mins)) return null;
    return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')}`;
};

/**
 * Turn stored rows into the lines a deck should print.
 *
 * Each of the five states gets its own wording, and none of them can be mistaken
 * for another. That is the whole reason the table stores a status rather than just a
 * nullable distance: "we looked and there is nothing within 15 km" and "we have not
 * computed this yet" are different facts about a site, and printing a blank for both
 * would throw away the distinction the backfill worked to preserve.
 *
 * @param {object} warehouse - carrying WarehouseProximity rows
 * @returns {Array<{label: string, value: string, detail: string}>}
 */
function proximityRows(warehouse) {
    const stored = new Map(
        ((warehouse && warehouse.WarehouseProximity) || []).map((r) => [r.category, r]),
    );

    const rows = [];
    for (const category of [...CATEGORIES].sort((a, b) => a.order - b.order)) {
        const row = stored.get(category.key);
        const base = { label: category.label, group: category.group, name: '', km: '', time: '', note: '' };

        if (!row) {
            // Never computed. Distinct from "nothing there" — see the note above.
            rows.push({ ...base, note: 'Not available' });
            continue;
        }

        if (row.status === STATUS.NONE_IN_RANGE) {
            rows.push({ ...base, note: `None within ${category.maxRadiusKm} km` });
            continue;
        }

        if (row.status === STATUS.ROUTING_FAILED) {
            rows.push({ ...base, name: row.landmarkName || '', note: 'Not routable' });
            continue;
        }

        // Access directly on the carriageway. Measured on 12 warehouses, where the
        // origin and the entry point snap to the same position, so the routed
        // distance is genuinely zero and is stored at the 0.01km floor. Printing
        // "0.01 km" would turn the strongest version of this fact into a rounding
        // artefact; the designation is already in the aside beside it, so the value
        // column only has to say that there is nothing to travel.
        if ((row.warnings || []).includes(WARNING.ON_HIGHWAY)) {
            rows.push({
                ...base,
                name: row.landmarkName || '',
                note: 'Direct access',
                // Emphasised, unlike every other note. The note cell exists for
                // ABSENCES — "None within 15 km", "Not available" — which should be
                // quiet. Fronting onto a highway is the strongest fact on the slide,
                // and the first render had it as the faintest text on the page:
                // italic 7.5pt muted, while every distance beside it was bold 10pt
                // navy. A reader scanning the column would skip the best row.
                emphasis: true,
            });
            continue;
        }

        // Ordering matters here. A highway row is METRIC_IDENTITY because the sweep
        // cannot measure a line, but a second producer
        // (scripts/backfillHighwayEntry.js) may have written a real roadKm onto the
        // same row by sampling the centreline. So a stored distance wins over the
        // category's metric, and the identity branch below is the FALLBACK for rows
        // no one has measured yet — not the rule for the category.
        if (!fmtKm(row.roadKm) && (category.metric === METRIC_IDENTITY || row.status === STATUS.IDENTITY_ONLY)) {
            // Named without a distance, deliberately. 95.5% of India's numbered
            // highway mileage is not access-controlled, so vehicles join it at
            // ordinary crossroads OSM has no reason to mark; a distance here would
            // describe a road you often cannot join at that point. The designation
            // goes in the value column, where the eye is already looking.
            rows.push({ ...base, note: row.landmarkName || 'Unnamed' });
            continue;
        }

        rows.push({
            ...base,
            name: row.landmarkName || '',
            km: fmtKm(row.roadKm) || '',
            time: fmtMin(row.driveMinutes) || '',
            note: fmtKm(row.roadKm) ? '' : 'Not available',
        });
    }
    return rows;
}

/**
 * Draw the slide: map left, distances right.
 *
 * @param {object} pptx
 * @param {object} warehouse
 * @param {number} optionNumber
 * @param {string|null} mapImage - data URI from fetchSiteMaps, or null
 * @returns {object|false} the slide, or false when there is nothing worth showing
 */
function generateProximitySlideV3(pptx, warehouse, optionNumber, mapImage) {
    const rows = proximityRows(warehouse);

    // A slide of nine "Not available" lines beside a blank rectangle tells a reader
    // nothing and looks like a fault. Skip it, exactly as the photos slide skips a
    // property with no photographs.
    const informative = rows.filter((r) => r.value !== 'Not available').length;
    if (!informative && !mapImage) {
        logWarn('proximitySlideV3', 'generateProximitySlideV3',
            'Skipping connectivity slide with no data and no map', { warehouseId: warehouse && warehouse.id });
        return false;
    }

    const slide = pptx.addSlide();
    slide.background = { color: COLORS.bg };
    addSlideTitle(slide, `Option ${optionNumber} - Connectivity`);

    // --- left: the site on a street map ---
    if (mapImage) {
        slide.addImage({
            data: mapImage,
            x: LAYOUT.MARGIN, y: LAYOUT.CONTENT_TOP,
            w: MAP_W, h: LAYOUT.CONTENT_H,
        });
    } else {
        slide.addText('Map unavailable', {
            x: LAYOUT.MARGIN, y: LAYOUT.CONTENT_TOP, w: MAP_W, h: LAYOUT.CONTENT_H,
            fill: { color: COLORS.sidebar }, align: 'center', valign: 'middle',
            fontFace: FONT, fontSize: 9, color: COLORS.navy,
        });
    }

    // --- right: the distances ---
    //
    // Three levels of hierarchy, so the eye lands in the right order:
    //   1. the DISTANCE, largest and boldest — it is the number a reader came for;
    //   2. the CATEGORY, semibold at body size — what the number is about;
    //   3. the LANDMARK NAME and DRIVE TIME, smaller and in a muted navy so they
    //      support the row without competing with it.
    //
    // Section headings were tried and removed: they cost two rows of vertical space
    // and cut the table into fragments without telling a reader anything the
    // ordering does not already. The order still follows the grouping — long-haul
    // connectivity first, local amenities after.
    //
    // Horizontal rules only. A full grid drew about thirty lines around twenty
    // numbers and made the eye work for nothing.
    const tableX = LAYOUT.MARGIN + MAP_W + LAYOUT.GUTTER;
    const tableW = LAYOUT.CONTENT_W - MAP_W - LAYOUT.GUTTER;
    const KM_W = 0.80;
    const TIME_W = 0.76;

    const rule = { type: 'solid', pt: 0.5, color: COLORS.divider };
    const noRule = { type: 'none' };
    /** Horizontal only: [top, right, bottom, left]. */
    const hOnly = [rule, noRule, rule, noRule];

    const head = (text, align) => ({
        text,
        options: {
            bold: true, color: COLORS.bg, fill: { color: COLORS.navy },
            fontFace: FONT_SEMIBOLD, fontSize: 7.5, valign: 'middle', margin: 0.06,
            align: align || 'left', border: [noRule, noRule, noRule, noRule],
        },
    });

    const table = [[head('Landmark'), head('By road', 'right'), head('Drive', 'right')]];

    for (const r of rows) {
        const label = r.name
            ? [
                { text: r.label, options: { breakLine: true } },
                {
                    // Regular weight, muted colour, still italic: it should read as
                    // an aside under the category rather than a second heading.
                    text: r.name.length <= NAME_MAX ? r.name : `${r.name.slice(0, NAME_MAX - 1).trimEnd()}…`,
                    options: {
                        fontFace: FONT, fontSize: 6.5, italic: true,
                        bold: false, color: COLORS.navyMuted,
                    },
                },
            ]
            : r.label;

        const labelCell = {
            text: label,
            options: {
                color: COLORS.navy, fontFace: FONT_SEMIBOLD, fontSize: 8,
                valign: 'middle', margin: 0.06, border: hOnly,
            },
        };

        // A row with no distance says so once, across both numeric columns, rather
        // than leaving two blanks a reader has to interpret.
        if (r.note) {
            table.push([labelCell, {
                text: r.note,
                options: {
                    colspan: 2,
                    // Matched to the distance cells it replaces, so an emphasised
                    // note carries the same weight in the column as a number would.
                    color: r.emphasis ? COLORS.navy : COLORS.navyMuted,
                    fontFace: r.emphasis ? FONT_SEMIBOLD : FONT,
                    fontSize: r.emphasis ? 10 : 7.5,
                    bold: !!r.emphasis,
                    italic: !r.emphasis,
                    align: 'right', valign: 'middle', margin: 0.06, border: hOnly,
                },
            }]);
            continue;
        }

        table.push([
            labelCell,
            {
                text: r.km,
                options: {
                    color: COLORS.navy, fontFace: FONT_SEMIBOLD, fontSize: 10,
                    bold: true, align: 'right', valign: 'middle', margin: 0.06,
                    border: hOnly,
                },
            },
            {
                text: r.time,
                options: {
                    color: COLORS.navyMuted, fontFace: FONT, fontSize: 7.5,
                    align: 'right', valign: 'middle', margin: 0.06, border: hOnly,
                },
            },
        ]);
    }

    const HEADER_H = 0.28;
    const bodyH = Math.max(0.24, (LAYOUT.CONTENT_H - HEADER_H) / rows.length);

    slide.addTable(table, {
        x: tableX, y: LAYOUT.CONTENT_TOP, w: tableW,
        colW: [tableW - KM_W - TIME_W, KM_W, TIME_W],
        rowH: [HEADER_H, ...Array(rows.length).fill(bodyH)],
        fill: { color: COLORS.sidebar },
    });

    addTopRightLogo(slide);
    addFooter(slide);
    return slide;
}

module.exports = {
    fetchSiteMap,
    fetchSiteMaps,
    generateProximitySlideV3,
    proximityRows,
    MAP_W,
    ZOOM,
    STYLE,
};
