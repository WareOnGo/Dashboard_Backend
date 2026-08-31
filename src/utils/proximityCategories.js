const { TARGET_HIGHWAY, categoryFor } = require('./osmCategories');

/**
 * What "nearby" means, per landmark category, for the warehouse proximity backfill.
 *
 * Two kinds of answer live here, and the distinction is deliberate:
 *
 *   METRIC_ROAD     — the nearest one, measured by road: km and drive time.
 *   METRIC_IDENTITY — the nearest one, named but NOT measured.
 *
 * Highways are identity-only, and that is a correctness decision rather than a
 * shortcut. Measured on the ingested data, 95.5% of India's numbered-highway
 * mileage is `trunk` or `primary` — not access-controlled — so vehicles join it at
 * ordinary crossroads that OSM has no reason to mark. That means we can say *which*
 * highway is nearest with confidence, but any distance we quoted would be either
 * distance-to-carriageway (which you often cannot actually use) or
 * distance-to-ramp (which only exists for the 4.5% that are access-controlled).
 * "Nearest highway: NH-48" is fully supportable; a number next to it is not, yet.
 */

const METRIC_ROAD = 'road';
const METRIC_IDENTITY = 'identity';

/**
 * @typedef {object} ProximityCategory
 * @property {string} key            - matches osm_poi.category, or the highway category
 * @property {string} label          - how it reads on a deck
 * @property {string} metric         - METRIC_ROAD | METRIC_IDENTITY
 * @property {number} maxRadiusKm    - beyond this we report "none in range" rather than
 *                                     a technically-nearest landmark nobody would drive to
 * @property {number} candidates     - how many to shortlist by straight line before routing
 * @property {number} order          - display order
 */

/**
 * Radii are generous where the category is genuinely sparse and tight where a
 * distant one would be meaningless. They are safe to set large because the POI
 * ingest is national: unlike a footprint-bounded dataset, there is no coverage edge
 * that would turn "nothing within 200 km" into an artefact of what we fetched.
 *
 * `candidates` is 1 for identity (nothing is being measured, so the straight-line
 * nearest IS the answer) and otherwise small — the shortlist exists only because
 * the nearest by line is not always the nearest by road.
 */
const CATEGORIES = [
    { key: 'national_highway', label: 'Nearest highway',        metric: METRIC_IDENTITY, maxRadiusKm: 50,  candidates: 1, order: 1 },
    { key: 'aerodrome',        label: 'Nearest airport',        metric: METRIC_ROAD,     maxRadiusKm: 200, candidates: 2, order: 2 },
    { key: 'railway_station',  label: 'Nearest railway station', metric: METRIC_ROAD,    maxRadiusKm: 100, candidates: 3, order: 3 },
    { key: 'seaport',          label: 'Nearest port',           metric: METRIC_ROAD,     maxRadiusKm: 300, candidates: 2, order: 4 },
    { key: 'city_centre',      label: 'Nearest city centre',    metric: METRIC_ROAD,     maxRadiusKm: 100, candidates: 2, order: 5 },
    { key: 'bus_station',      label: 'Nearest bus station',    metric: METRIC_ROAD,     maxRadiusKm: 25,  candidates: 3, order: 6 },
    { key: 'hospital',         label: 'Nearest hospital',       metric: METRIC_ROAD,     maxRadiusKm: 25,  candidates: 3, order: 7 },
    { key: 'fire_station',     label: 'Nearest fire station',   metric: METRIC_ROAD,     maxRadiusKm: 25,  candidates: 3, order: 8 },
    { key: 'police',           label: 'Nearest police station', metric: METRIC_ROAD,     maxRadiusKm: 25,  candidates: 3, order: 9 },
    { key: 'fuel',             label: 'Nearest fuel station',   metric: METRIC_ROAD,     maxRadiusKm: 15,  candidates: 3, order: 10 },
    { key: 'substation',       label: 'Nearest substation',     metric: METRIC_ROAD,     maxRadiusKm: 30,  candidates: 3, order: 11 },
];

const BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));

/** @returns {ProximityCategory|undefined} */
const proximityCategoryFor = (key) => BY_KEY.get(key);

const proximityKeys = () => CATEGORIES.map((c) => c.key);

/** Categories whose landmark lives in osm_highway rather than osm_poi. */
const isHighway = (key) => {
    const ingest = categoryFor(key);
    return !!ingest && ingest.target === TARGET_HIGHWAY;
};

/** Categories that need a routing call. */
const routedCategories = () => CATEGORIES.filter((c) => c.metric === METRIC_ROAD);

module.exports = {
    CATEGORIES,
    METRIC_ROAD,
    METRIC_IDENTITY,
    proximityCategoryFor,
    proximityKeys,
    routedCategories,
    isHighway,
};
