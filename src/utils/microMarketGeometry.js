// src/utils/microMarketGeometry.js
/**
 * Pure point-in-polygon helpers for micro-market tagging. No DB access, so both
 * the runtime tagger (MicroMarketService.tagsForPoint) and the one-off backfill
 * script share exactly one implementation of the containment rule.
 */

/**
 * Ray-casting containment test for a single linear ring of [lon, lat] pairs.
 * Planar maths is accurate enough at city scale, and matches how the polygons
 * were drawn (on a flat Leaflet canvas) in the first place.
 * @param {Array<[number, number]>} ring
 * @param {number} lon
 * @param {number} lat
 * @returns {boolean}
 */
function inRing(ring, lon, lat) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        const intersects =
            yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
        if (intersects) inside = !inside;
    }
    return inside;
}

/**
 * A GeoJSON polygon is one outer ring followed by any number of holes.
 * @param {Array<Array<[number, number]>>} rings
 * @param {number} lon
 * @param {number} lat
 * @returns {boolean}
 */
function inPolygon(rings, lon, lat) {
    if (!rings.length || !inRing(rings[0], lon, lat)) return false;
    return !rings.slice(1).some((hole) => inRing(hole, lon, lat));
}

/**
 * Unwrap a Feature to its geometry. The mapper stores bare geometry, but shapes
 * come off Leaflet as Features and one could slip through.
 * @param {Object} geometry
 * @returns {Object|null}
 */
function toGeometry(geometry) {
    if (!geometry) return null;
    return geometry.type === 'Feature' ? geometry.geometry || null : geometry;
}

/** @returns {boolean} true if the geometry is a shape we can test against. */
function isSupported(geometry) {
    const geom = toGeometry(geometry);
    return geom?.type === 'Polygon' || geom?.type === 'MultiPolygon';
}

/**
 * Does the polygon contain the point?
 * @param {Object} geometry - GeoJSON Polygon/MultiPolygon (or Feature wrapping one)
 * @param {number} lon
 * @param {number} lat
 * @returns {boolean}
 */
function contains(geometry, lon, lat) {
    const geom = toGeometry(geometry);
    if (!geom) return false;
    if (geom.type === 'Polygon') return inPolygon(geom.coordinates, lon, lat);
    if (geom.type === 'MultiPolygon') {
        return geom.coordinates.some((poly) => inPolygon(poly, lon, lat));
    }
    return false;
}

/**
 * The tag stored on Warehouse.micromarket for a polygon: its name, falling back
 * to its id so an unnamed polygon still produces a usable tag.
 * @param {{id: string, name?: string}} market
 * @returns {string}
 */
function labelFor(market) {
    return (market.name || '').trim() || market.id;
}

/**
 * Tags for a point: every polygon containing it, de-duplicated and sorted so the
 * stored array is stable and comparable across runs.
 * @param {Array<{id: string, name?: string, geometry: Object}>} markets
 * @param {number} lat
 * @param {number} lon
 * @returns {string[]}
 */
function resolveTags(markets, lat, lon) {
    if (lat == null || lon == null || Number.isNaN(lat) || Number.isNaN(lon)) return [];
    const labels = markets
        .filter((m) => contains(m.geometry, lon, lat))
        .map(labelFor);
    return [...new Set(labels)].sort();
}

module.exports = {
    inRing,
    inPolygon,
    contains,
    isSupported,
    labelFor,
    resolveTags,
};
