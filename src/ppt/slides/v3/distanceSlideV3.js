const axios = require('axios');
const { LAYOUT, COLORS, FONT, FONT_SEMIBOLD, addSlideTitle } = require('./layoutV3');
const { addFooter, addTopRightLogo } = require('../v2/chromeV2');
const { logInfo, logWarn } = require('../../utils/logger');

/**
 * How far each proposed property is from a site the client already operates.
 *
 * Road distance and drive time come from the Directions API, one request per
 * option in parallel — deliberately not the Matrix API, which answers the same
 * question in a single request but disagrees with Directions on the same leg.
 * Measured on five Hyderabad options from one origin: the two agreed exactly on
 * two legs and diverged 42-67% on the other three, with Matrix reporting a longer
 * distance and a shorter time each time — it prefers a faster ring-road route
 * where Directions takes the shorter city one. Both are internally consistent,
 * but Matrix's 65km where Directions says 39km is the number a client who knows
 * the area would call wrong, and this deck has to survive that reading.
 *
 * Five parallel Directions calls measured 726ms against Matrix's 520ms, so the
 * accuracy costs about 200ms — and none of it lands on the clock, because the
 * request is started before the deck is drawn.
 */

const DIRECTIONS_TIMEOUT_MS = 8000;
const MAP_TIMEOUT_MS = 8000;

// The Static Images API refuses requests over 8,192 characters. Routes are drawn
// from Mapbox's own `simplified` geometry, which measured 1,934 characters of URL
// for five routes once percent-encoded — roughly 300 per route, so about 25 fit.
// (`full` geometry was 21,747 characters for the same five and is unusable here.)
// The cap is checked anyway rather than assumed: an unusually long route, or a
// deck with many options, drops the lines and keeps the pins.
const URL_LIMIT = 8192;
const URL_SAFETY_MARGIN = 200;

// Distinct from the navy option pins so the client's own site reads as the thing
// everything else is measured against, not as another option.
const CLIENT_PIN = 'pin-l-star+C0392B';
const OPTION_PIN_COLOR = COLORS.navy.replace('#', '');

/** Parse a client-supplied location, tolerating strings from a form field. */
function parseClientLocation(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const lat = Number(raw.lat ?? raw.latitude);
    const lng = Number(raw.lng ?? raw.lon ?? raw.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng, label: String(raw.label || '').trim() || 'Client site' };
}

/** Options that can be measured, each keeping its option number. */
function measurableOptions(warehouses) {
    return warehouses
        .map((w, i) => {
            const wd = w.WarehouseData || {};
            return {
                option: i + 1,
                id: w.id,
                name: w.projectName || w.address || [w.city, w.state].filter(Boolean).join(', ') || `Property ${w.id}`,
                lat: wd.latitude,
                lng: wd.longitude,
            };
        })
        .filter((o) => Number.isFinite(o.lat) && Number.isFinite(o.lng));
}

/** One driving leg. Resolves to null rather than throwing, so one dead leg is not a dead deck. */
async function fetchLeg(token, from, to) {
    // `simplified` geometry is what the map draws — detailed enough to follow the
    // real roads at this size, short enough to survive the URL cap.
    // `geometries=polyline` is precision 5, which is the encoding the Static
    // Images path overlay expects; polyline6 would render in the wrong place.
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${from.lng},${from.lat};${to.lng},${to.lat}`
        + `?overview=simplified&geometries=polyline&access_token=${token}`;
    try {
        const res = await axios.get(url, { timeout: DIRECTIONS_TIMEOUT_MS });
        const route = res.data?.routes?.[0];
        if (!route) return null;
        return { km: route.distance / 1000, minutes: route.duration / 60, geometry: route.geometry || null };
    } catch (_) {
        return null;
    }
}

/**
 * Assemble the static-map URL, dropping the route lines if they would push the
 * request past the API's limit.
 *
 * Pure, and exported, so the fallback can be exercised without the network — it
 * is the branch that only fires on an unusually long deck, which is exactly the
 * kind of path that otherwise ships untested.
 *
 * @returns {{url: string, withPaths: boolean, urlLength: number}} urlLength is
 *   the length of the *attempted* full request, so a caller can log why it fell back.
 */
function buildComparisonMapUrl({ token, paths, pins, width, height }) {
    const build = (overlay) => `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${overlay.join(',')}`
        + `/auto/${width}x${height}@2x?padding=45&access_token=${token}`;

    const full = build([...paths, ...pins]);
    if (paths.length === 0 || full.length <= URL_LIMIT - URL_SAFETY_MARGIN) {
        return { url: full, withPaths: paths.length > 0, urlLength: full.length };
    }
    return { url: build(pins), withPaths: false, urlLength: full.length };
}

/**
 * A map with the driving route to each option drawn, the client's site starred,
 * and the options numbered.
 *
 * Paths are listed before the pins because overlay order is z-order: the lines
 * have to sit under the markers, not over them.
 */
async function fetchComparisonMap(token, client, options, routes) {
    const width = 640;
    const height = 700;

    const paths = routes
        .filter((r) => r && r.geometry)
        .map((r) => `path-2+${OPTION_PIN_COLOR}-0.75(${encodeURIComponent(r.geometry)})`);
    const pins = [
        `${CLIENT_PIN}(${client.lng.toFixed(5)},${client.lat.toFixed(5)})`,
        ...options
            .filter((o) => o.option <= 99)
            .map((o) => `pin-s-${o.option}+${OPTION_PIN_COLOR}(${o.lng.toFixed(5)},${o.lat.toFixed(5)})`),
    ];

    const { url, withPaths, urlLength } = buildComparisonMapUrl({ token, paths, pins, width, height });
    if (paths.length > 0 && !withPaths) {
        logWarn('distanceSlideV3', 'fetchComparisonMap', 'Route lines dropped — the request would exceed the URL limit', {
            urlLength, routes: paths.length,
        });
    }

    try {
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: MAP_TIMEOUT_MS });
        return { dataUri: `image/png;base64,${Buffer.from(res.data).toString('base64')}`, withPaths };
    } catch (_) {
        return null;
    }
}

/**
 * Gather everything the slide needs. Never throws; returns null when the slide
 * should not exist at all.
 *
 * Start this before drawing the deck and await it at the end, so the routing
 * calls overlap the photo downloads.
 */
async function fetchDistanceComparison(warehouses, customDetails = {}, flags = {}) {
    const client = parseClientLocation(customDetails.clientLocation);
    if (!client) return null;
    if (flags.mapsLocation === false) return null;

    const token = process.env.MAPBOX_ACCESS_TOKEN;
    if (!token) {
        logWarn('distanceSlideV3', 'fetchDistanceComparison', 'MAPBOX_ACCESS_TOKEN not configured — skipping the distance slide');
        return null;
    }

    const options = measurableOptions(warehouses);
    if (options.length === 0) return null;

    const startedAt = Date.now();
    // The map now draws the routes, so it needs their geometry: legs first, then
    // the image. Both still sit inside the window the photo downloads occupy.
    const legs = await Promise.all(options.map((o) => fetchLeg(token, client, o)));
    const map = await fetchComparisonMap(token, client, options, legs);

    const rows = options.map((o, i) => ({ ...o, ...(legs[i] || { km: null, minutes: null }) }));
    const measured = rows.filter((r) => r.km !== null).length;

    if (measured === 0) {
        logWarn('distanceSlideV3', 'fetchDistanceComparison', 'No leg could be routed — skipping the distance slide');
        return null;
    }

    logInfo('distanceSlideV3', 'fetchDistanceComparison', 'Distance comparison ready', {
        measured, options: options.length, hasMap: !!map, routesDrawn: !!map?.withPaths,
        durationMs: Date.now() - startedAt,
    });

    return {
        client, rows, measured,
        mapImage: map?.dataUri || null,
        routesDrawn: !!map?.withPaths,
        total: warehouses.length,
    };
}

const fmtKm = (km) => (km === null ? 'Not routable' : `${km < 10 ? km.toFixed(1) : Math.round(km)} km`);
const fmtMin = (m) => {
    if (m === null) return '—';
    const mins = Math.round(m);
    return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')} min`;
};

/**
 * Table on the left, map on the right. Rows stay in option order rather than
 * sorting by distance: the reader is cross-referencing the option numbers they
 * have just been shown, and re-ordering them here would work against that.
 */
function generateDistanceSlideV3(pptx, data) {
    const slide = pptx.addSlide();
    slide.background = { color: COLORS.bg };
    addSlideTitle(slide, `Distance from ${data.client.label}`);

    const MAP_W = 4.30;
    const tableW = LAYOUT.CONTENT_W - MAP_W - LAYOUT.GUTTER;

    const headerOpts = {
        bold: true, color: COLORS.bg, fill: { color: COLORS.navy },
        fontFace: FONT_SEMIBOLD, fontSize: 8, valign: 'middle', margin: 0.05,
    };
    const cellOpts = {
        color: COLORS.navy, fill: { color: COLORS.sidebar },
        fontFace: FONT, fontSize: 8, valign: 'middle', margin: 0.05,
    };

    const rows = [[
        { text: '#', options: { ...headerOpts, align: 'center' } },
        { text: 'Property', options: headerOpts },
        { text: 'By road', options: { ...headerOpts, align: 'right' } },
        { text: 'Drive', options: { ...headerOpts, align: 'right' } },
    ]];

    for (const r of data.rows) {
        const name = r.name.length <= 42 ? r.name : `${r.name.slice(0, 41).trimEnd()}…`;
        rows.push([
            { text: String(r.option), options: { ...cellOpts, align: 'center' } },
            { text: name, options: cellOpts },
            { text: fmtKm(r.km), options: { ...cellOpts, align: 'right' } },
            { text: fmtMin(r.minutes), options: { ...cellOpts, align: 'right' } },
        ]);
    }

    const rowH = Math.min(0.42, (LAYOUT.CONTENT_H - 0.5) / rows.length);
    slide.addTable(rows, {
        x: LAYOUT.MARGIN, y: LAYOUT.CONTENT_TOP, w: tableW,
        colW: [0.32, tableW - 0.32 - 0.86 - 0.78, 0.86, 0.78],
        rowH: rows.map(() => rowH),
        border: { type: 'solid', pt: 0.5, color: COLORS.divider },
    });

    // Says what the numbers are, so nobody reads them as straight-line.
    slide.addText(
        data.routesDrawn
            ? 'Road distance and typical driving time. The map shows the driving route from the client site to each option.'
            : 'Road distance and typical driving time, measured from the client site marked on the map.',
        {
            x: LAYOUT.MARGIN, y: LAYOUT.CONTENT_TOP + rows.length * rowH + 0.12,
            w: tableW, h: 0.4,
            fontFace: FONT, fontSize: 7.5, color: COLORS.navy, valign: 'top',
        },
    );

    if (data.mapImage) {
        slide.addImage({
            data: data.mapImage,
            x: LAYOUT.MARGIN + tableW + LAYOUT.GUTTER, y: LAYOUT.CONTENT_TOP,
            w: MAP_W, h: LAYOUT.CONTENT_H,
        });
    }

    addTopRightLogo(slide);
    addFooter(slide);
    return slide;
}

module.exports = {
    fetchDistanceComparison,
    generateDistanceSlideV3,
    parseClientLocation,
    buildComparisonMapUrl,
};
