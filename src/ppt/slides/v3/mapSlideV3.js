const axios = require('axios');
const { LAYOUT, COLORS, addSlideTitle } = require('./layoutV3');
const { addFooter, addTopRightLogo } = require('../v2/chromeV2');
const { logInfo, logWarn } = require('../../utils/logger');

/**
 * One map of every option in the deck, marked with numbered pins.
 *
 * Fetched from the Mapbox Static Images API as a single image for the whole
 * deck, not one per property: markers cost about 33 characters of URL each, so
 * the 8,192-character limit allows far more properties than a proposal will ever
 * carry, and the request count stays at one however long the deck is.
 *
 * The caller is expected to start `fetchOverviewMap` before building the
 * property slides and await it afterwards. Measured against production data, a
 * four-property deck spends ~3.2s fetching photographs, and a cold map request
 * is 0.7–2.9s — so overlapped it costs nothing, where fetching it in slide order
 * would add most of itself to every export.
 */

// The slide's content box is about 2.06:1, so the image is requested at that
// shape and fills it exactly rather than being letterboxed.
const IMAGE_W = 1280;
const IMAGE_H = Math.round(IMAGE_W / (LAYOUT.CONTENT_W / LAYOUT.CONTENT_H));

// streets-v12 rather than the minimal light basemap: at the metro zoom a
// proposal actually lands on, light-v11 renders little beyond city names, so a
// reader cannot place a pin against the roads and areas they know.
const STYLE = 'streets-v12';
const PIN_COLOR = COLORS.navy.replace('#', '');
const PADDING = 50;

// Bounded so a slow Mapbox cannot hold up a deck the user is waiting on. The
// request runs alongside the photo downloads, so this is headroom over the ~2.9s
// worst case measured, not a budget anyone waits out in the normal case.
const TIMEOUT_MS = 8000;

// Mapbox renders pin labels for 0-99 and single letters; beyond that the label
// is dropped and every pin looks alike, which is worse than an unlabelled map.
const MAX_LABELLED_PINS = 99;

/** Options that can actually be plotted, each keeping its option number. */
function plottableOptions(warehouses) {
    return warehouses
        .map((w, i) => {
            const wd = w.WarehouseData || {};
            return { option: i + 1, lat: wd.latitude, lng: wd.longitude };
        })
        .filter(({ lat, lng }) => typeof lat === 'number' && typeof lng === 'number'
            && Number.isFinite(lat) && Number.isFinite(lng)
            && Math.abs(lat) <= 90 && Math.abs(lng) <= 180);
}

/**
 * `auto` fits the viewport to the overlay, which is meaningless when every pin
 * sits on the same spot — one property, or several at the same address. Those
 * fall back to an explicit centre and a street-level zoom.
 */
function viewport(points) {
    const lats = points.map((p) => p.lat);
    const lngs = points.map((p) => p.lng);
    const spread = Math.max(Math.max(...lats) - Math.min(...lats), Math.max(...lngs) - Math.min(...lngs));

    if (points.length === 1 || spread < 0.002) {
        const lat = lats.reduce((a, b) => a + b, 0) / lats.length;
        const lng = lngs.reduce((a, b) => a + b, 0) / lngs.length;
        return `${lng.toFixed(5)},${lat.toFixed(5)},12`;
    }
    return 'auto';
}

/**
 * Fetch the overview map. Never throws and never rejects: a deck without its map
 * slide is a lesser deck, not a failed one.
 *
 * @returns {Promise<{dataUri: string, plotted: number, total: number}|null>}
 */
async function fetchOverviewMap(warehouses, flags = {}) {
    // Withholding the coordinates from the table and then plotting them is a
    // contradiction, so the same flag drops this slide.
    if (flags.mapsLocation === false) return null;

    const token = process.env.MAPBOX_ACCESS_TOKEN;
    if (!token) {
        logWarn('mapSlideV3', 'fetchOverviewMap', 'MAPBOX_ACCESS_TOKEN not configured — skipping the overview map');
        return null;
    }

    const points = plottableOptions(warehouses);
    if (points.length === 0) {
        logInfo('mapSlideV3', 'fetchOverviewMap', 'No property has coordinates — skipping the overview map');
        return null;
    }

    const pins = points
        .filter((p) => p.option <= MAX_LABELLED_PINS)
        .map((p) => `pin-s-${p.option}+${PIN_COLOR}(${p.lng.toFixed(5)},${p.lat.toFixed(5)})`)
        .join(',');

    const url = `https://api.mapbox.com/styles/v1/mapbox/${STYLE}/static/${pins}`
        + `/${viewport(points)}/${IMAGE_W}x${IMAGE_H}@2x?padding=${PADDING}&access_token=${token}`;

    const startedAt = Date.now();
    try {
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: TIMEOUT_MS });
        const buffer = Buffer.from(res.data);
        logInfo('mapSlideV3', 'fetchOverviewMap', 'Overview map fetched', {
            plotted: points.length, total: warehouses.length,
            bytes: buffer.length, durationMs: Date.now() - startedAt,
        });
        return {
            dataUri: `image/png;base64,${buffer.toString('base64')}`,
            plotted: points.length,
            total: warehouses.length,
        };
    } catch (error) {
        logWarn('mapSlideV3', 'fetchOverviewMap', 'Overview map unavailable — skipping the slide', {
            error: error.message, status: error.response?.status, durationMs: Date.now() - startedAt,
        });
        return null;
    }
}

/**
 * Add the map slide. Call only with a resolved `fetchOverviewMap` result.
 *
 * Appends like any other slide; the caller moves it into position, because the
 * slide belongs after the index but its image should be fetched alongside the
 * photographs rather than ahead of them.
 */
function generateMapSlideV3(pptx, map) {
    const slide = pptx.addSlide();
    slide.background = { color: COLORS.bg };

    // Say so when not every option is on the map, rather than letting a reader
    // assume a missing pin means a missing property.
    const title = map.plotted === map.total
        ? 'Location Overview'
        : `Location Overview (${map.plotted} of ${map.total} located)`;
    addSlideTitle(slide, title);

    slide.addImage({
        data: map.dataUri,
        x: LAYOUT.MARGIN, y: LAYOUT.CONTENT_TOP,
        w: LAYOUT.CONTENT_W, h: LAYOUT.CONTENT_H,
    });

    addTopRightLogo(slide);
    addFooter(slide);
    return slide;
}

module.exports = { fetchOverviewMap, generateMapSlideV3, IMAGE_W, IMAGE_H };
