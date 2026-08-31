const axios = require('axios');

/**
 * The one place a paid Mapbox Directions request is made.
 *
 * Two callers with different needs, which is the reason this is a module rather
 * than a copied function:
 *
 *   the v3 distance slide  needs route GEOMETRY, because it draws the route
 *   the proximity backfill needs only km and minutes
 *
 * `overview: 'false'` drops the geometry, taking a response from ~2 KB to ~200
 * bytes. Across the backfill's ~29,000 legs that is ~50 MB not transferred, for a
 * field nothing would read.
 *
 * WHY DIRECTIONS AND NOT MATRIX. Matrix answers one origin against many
 * destinations in a single request, which would turn 27 calls per warehouse into
 * one. Measured on five real legs from a single origin, the two agreed exactly on
 * two and diverged 42-67% on the other three, with Matrix reporting a longer
 * distance and a shorter time each time — it prefers a ring-road route where
 * Directions takes the shorter city one. Since a shortlist is by construction a set
 * of candidates within 1.7x of each other, an error of that size across that spread
 * means Matrix would often pick the WRONG WINNER, and the bias is systematically
 * wrong for peripheral industrial belts, which is where warehouses are.
 */

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * `driving` rather than `driving-traffic`. Traffic-aware times measured more
 * realistic (71 min against 87 on one leg) but vary with when the call is made, so
 * the same deck generated twice would disagree with itself. A stored number has to
 * be reproducible.
 */
const PROFILE = 'driving';
const PROVIDER = 'mapbox-directions';

/**
 * Token bucket. Directions allows roughly 300 requests a minute, and that ceiling
 * — not concurrency — is what bounds the backfill: five parallel legs measured
 * 726 ms, i.e. ~2,000/min of available parallelism. A worker pool alone would
 * therefore blow straight through the limit.
 */
class TokenBucket {
    constructor(perMinute) {
        this.intervalMs = perMinute > 0 ? 60000 / perMinute : 0;
        this.next = 0;
    }

    /** Reserves a slot before awaiting it, so N concurrent callers space out. */
    async take(sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
        if (!this.intervalMs) return;
        const now = Date.now();
        const slot = Math.max(now, this.next);
        this.next = slot + this.intervalMs;
        if (slot > now) await sleep(slot - now);
    }
}

/**
 * One driving leg.
 *
 * Resolves to null on any failure rather than throwing — the enrichment must never
 * break the job that triggered it, the same contract as
 * MicroMarketService.tagsForPoint.
 *
 * `alternatives` is deliberately never requested: measured, it CHANGES the primary
 * route returned (88.4 km/84 min against 62.0 km/97 min for one pair), so a stored
 * number would depend on a flag unrelated to the question.
 *
 * @param {string} token
 * @param {{lat: number, lng: number}} from
 * @param {{lat: number, lng: number}} to
 * @param {object} [opts]
 * @param {'false'|'simplified'|'full'} [opts.overview] - 'false' for numbers only
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.http] - injected for tests
 * @returns {Promise<{km: number, minutes: number, geometry: string|null}|null>}
 */
async function fetchLeg(token, from, to, {
    overview = 'false',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    http = null,
} = {}) {
    // Mapbox coordinates are lng,lat — the opposite order to how every row in this
    // codebase reads. Transposing them silently returns a plausible route between
    // two entirely different places.
    const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
    const geometryParam = overview === 'false' ? '' : '&geometries=polyline';
    const url = `https://api.mapbox.com/directions/v5/mapbox/${PROFILE}/${coords}`
        + `?overview=${overview}${geometryParam}&access_token=${token}`;

    try {
        const get = http || ((u, c) => axios.get(u, c));
        const res = await get(url, { timeout: timeoutMs });
        const route = res && res.data && res.data.routes && res.data.routes[0];
        if (!route || !Number.isFinite(route.distance) || !Number.isFinite(route.duration)) return null;
        return {
            km: route.distance / 1000,
            minutes: route.duration / 60,
            geometry: route.geometry || null,
        };
    } catch (_) {
        return null;
    }
}

module.exports = { fetchLeg, TokenBucket, PROFILE, PROVIDER, DEFAULT_TIMEOUT_MS };
