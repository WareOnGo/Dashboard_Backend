const { METRIC_IDENTITY } = require('./proximityCategories');

/**
 * Turning a shortlist of candidate landmarks into the one row we store.
 *
 * Pure: no database, no network. Both the backfill script and any later sweep run
 * through this, so the rule for "which landmark wins" and "what does silence mean"
 * has exactly one implementation — the same reason src/utils/microMarketGeometry.js
 * exists apart from its callers.
 */

/**
 * A candidate further than this multiple of the nearest one's straight-line
 * distance cannot overtake it by road, so routing to it is wasted money.
 *
 * Measured road-to-direct ratios in Bengaluru fell between 1.45 and 1.9. Widened
 * conservatively to [1.2, 2.0], the worst possible swing between two candidates is
 * 2.0/1.2 = 1.67. Anything beyond that only wins if the road network is genuinely
 * pathological — an unbridged river, a restricted zone — which is a case worth
 * FLAGGING rather than silently paying to measure.
 */
const MAX_DIRECT_RATIO = 1.7;

/** Above this road-to-direct ratio, something is wrong with the coordinates or the network. */
const DETOUR_RATIO_WARN = 4;

const STATUS = Object.freeze({
    /** Routed. roadKm and driveMinutes are real numbers. */
    OK: 'OK',
    /** The nearest one is known and named; no distance is reported, by design. */
    IDENTITY_ONLY: 'IDENTITY_ONLY',
    /** We looked. Nothing of this category inside the category's radius. */
    NONE_IN_RANGE: 'NONE_IN_RANGE',
    /** Candidates existed; none could be routed to. */
    ROUTING_FAILED: 'ROUTING_FAILED',
});

const WARNING = Object.freeze({
    /** Road distance is implausibly larger than straight line — suspect coordinates. */
    DETOUR_RATIO_HIGH: 'DETOUR_RATIO_HIGH',
    /** The second candidate beat the first, so straight-line order was misleading here. */
    NEAREST_BY_ROAD_DIFFERS: 'NEAREST_BY_ROAD_DIFFERS',
});

/**
 * Drop candidates that cannot win, keeping input order.
 *
 * Always keeps the nearest, so an empty result is impossible for a non-empty input.
 *
 * @param {Array<{directM: number}>} candidates - ascending by directM
 * @param {number} [maxRatio]
 * @returns {Array} the subset worth routing to
 */
function guardCandidates(candidates, maxRatio = MAX_DIRECT_RATIO) {
    if (!candidates || candidates.length <= 1) return candidates || [];
    const nearest = candidates[0].directM;
    // A nearest distance of zero would make every ratio infinite; the landmark is
    // on top of the warehouse, so nothing else can beat it anyway.
    if (!(nearest > 0)) return [candidates[0]];
    return candidates.filter((c, i) => i === 0 || c.directM <= nearest * maxRatio);
}

/**
 * Decide the stored row for one warehouse and one category.
 *
 * @param {object} args
 * @param {object} args.category - a proximityCategories entry
 * @param {Array<object>} args.candidates - shortlist, ascending by directM. Each
 *   carries poiSource, poiId, name, lat, lng, directM.
 * @param {Array<{km: number, minutes: number}|null>} [args.legs] - routing result
 *   per candidate, positionally aligned. Ignored for identity categories.
 * @returns {object} the row to store, minus the warehouse id and provenance
 */
function resolve({ category, candidates, legs = [] }) {
    const shortlist = candidates || [];

    if (!shortlist.length) {
        // Persisted as a row, not left absent: an absent row means "never computed",
        // and conflating the two would make the backfill re-shortlist this category
        // on every future run, forever.
        return {
            status: STATUS.NONE_IN_RANGE,
            landmarkName: null, poiSource: null, poiId: null, poiLat: null, poiLng: null,
            roadKm: null, driveMinutes: null, candidates: 0, warnings: [],
        };
    }

    const best = shortlist[0];
    const base = {
        landmarkName: best.name || null,
        poiSource: best.poiSource,
        poiId: best.poiId,
        poiLat: best.lat,
        poiLng: best.lng,
        candidates: shortlist.length,
    };

    if (category.metric === METRIC_IDENTITY) {
        // Nothing was measured, so the straight-line nearest IS the answer. The
        // status says so explicitly rather than leaving a reader to infer it from
        // two null distance columns.
        return { ...base, status: STATUS.IDENTITY_ONLY, roadKm: null, driveMinutes: null, warnings: [] };
    }

    // Pick by ROAD distance, not by the straight-line order the shortlist arrived
    // in. This is the entire reason more than one candidate is fetched: measured in
    // Bengaluru, a 35 km straight line came to 62 km by road while a further
    // candidate was closer to drive.
    let winner = -1;
    for (let i = 0; i < shortlist.length; i++) {
        const leg = legs[i];
        if (!leg || !Number.isFinite(leg.km)) continue;
        if (winner === -1 || leg.km < legs[winner].km) winner = i;
    }

    if (winner === -1) {
        // Candidates existed but none routed. Distinct from NONE_IN_RANGE, because
        // "there is nothing there" and "we could not get there" are different facts
        // about a site, and only one of them is the site's fault.
        return {
            ...base,
            status: STATUS.ROUTING_FAILED,
            roadKm: null, driveMinutes: null,
            warnings: [],
        };
    }

    const chosen = shortlist[winner];
    const leg = legs[winner];
    const warnings = [];
    if (winner !== 0) warnings.push(WARNING.NEAREST_BY_ROAD_DIFFERS);
    // Evaluated here because both numbers are in hand exactly once. The straight-line
    // distance is not stored, so this conclusion is the only thing that survives it.
    if (chosen.directM > 0 && (leg.km * 1000) / chosen.directM > DETOUR_RATIO_WARN) {
        warnings.push(WARNING.DETOUR_RATIO_HIGH);
    }

    return {
        status: STATUS.OK,
        landmarkName: chosen.name || null,
        poiSource: chosen.poiSource,
        poiId: chosen.poiId,
        poiLat: chosen.lat,
        poiLng: chosen.lng,
        roadKm: Math.round(leg.km * 10) / 10,
        driveMinutes: Math.round(leg.minutes),
        candidates: shortlist.length,
        warnings,
    };
}

module.exports = {
    guardCandidates,
    resolve,
    STATUS,
    WARNING,
    MAX_DIRECT_RATIO,
    DETOUR_RATIO_WARN,
};
