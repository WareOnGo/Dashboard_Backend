const axios = require('axios');

/**
 * A locally-hosted Valhalla, as an alternative routing backend.
 *
 * Same contract as src/utils/mapboxDirections.js and src/utils/osrmRouting.js —
 * same function names, same return shapes, and the same crucial distinction that
 * `null` means "the service answered and there is no route" while THROWING means
 * "we could not ask". Conflating those is what would record an outage as a fact
 * about a warehouse.
 *
 * WHY VALHALLA AND NOT OSRM. OSRM was the first choice: it is what Mapbox's own
 * Directions API is built on, so its responses need almost no adapting, it has the
 * healthiest release cadence of the three engines, and the largest deployed base.
 * It was killed by the OOM killer twice on this machine building the India extract,
 * both times at the same phase, even capped to 4 threads with 18 GB free. Valhalla
 * builds the same country in a few hundred MB. A routing engine that cannot finish
 * preprocessing is not more reliable in any sense that matters.
 *
 * WHAT THIS LETS US DELETE. The Mapbox path has to approximate: each call costs
 * money and a rate-limit slot, so the backfill shortlists by straight-line
 * distance, prunes with a ratio guard, routes the survivors and hopes the winner
 * was among them. Measured, k=2 named the wrong landmark 12.1% of the time, k=3
 * 6.9%, k=12 1.7%. A local engine has no per-request cost, and
 * /sources_to_targets is exact, so the shortlist collapses into "take every
 * candidate in radius, ask once, keep the minimum" — a miss rate of zero.
 *
 * CAVEAT WORTH REPEATING: this is a different engine on different data. A
 * Geofabrik extract has its own vintage and there is no traffic model here at all.
 * Numbers will not match Mapbox exactly, and neither is automatically right.
 */

const DEFAULT_ENDPOINT = process.env.VALHALLA_ENDPOINT || 'http://localhost:8002';
const DEFAULT_TIMEOUT_MS = 30000;

/** Valhalla's costing model for a lorry-ish road vehicle. */
const COSTING = 'auto';
const PROFILE = 'auto';
const PROVIDER = 'valhalla-local';

/**
 * Targets per /sources_to_targets request.
 *
 * Valhalla has no hard cap comparable to OSRM's --max-table-size, but a matrix is
 * O(sources x targets) work and an enormous single request makes a timeout mean
 * losing everything. Chunking keeps each request cheap and independently
 * retryable.
 */
const MAX_TARGETS = Number(process.env.VALHALLA_MAX_TARGETS || 200);

class ValhallaUnavailableError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'ValhallaUnavailableError';
        this.status = status;
        this.retryable = true;
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_DELAYS_MS = [500, 2000, 5000];

/** Valhalla speaks lat/lon objects, not the lng,lat strings the other two use. */
const point = (p) => ({ lat: p.lat, lon: p.lng });

/**
 * Road distance and drive time from one origin to many destinations, exactly, in
 * as few requests as possible.
 *
 * @param {*} _token - unused; kept so this is positionally interchangeable
 * @param {{lat: number, lng: number}} origin
 * @param {Array<{lat: number, lng: number}>} destinations
 * @param {object} [opts]
 * @returns {Promise<Array<{km: number, minutes: number}|null>>} aligned with
 *   `destinations`; null where Valhalla found no route.
 * @throws {ValhallaUnavailableError} when the service could not be reached
 */
async function fetchLegsFrom(_token, origin, destinations, opts = {}) {
    if (!destinations || !destinations.length) return [];

    const endpoint = opts.endpoint || DEFAULT_ENDPOINT;
    const gate = opts.onRequest || (() => Promise.resolve());
    const post = opts.http || ((u, b, c) => axios.post(u, b, c));
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const chunkSize = Math.max(1, opts.maxTargets || MAX_TARGETS);

    const out = new Array(destinations.length).fill(null);

    for (let start = 0; start < destinations.length; start += chunkSize) {
        const chunk = destinations.slice(start, start + chunkSize);
        const body = {
            sources: [point(origin)],
            targets: chunk.map(point),
            costing: COSTING,
            // Distances in km rather than the default miles.
            units: 'kilometers',
        };

        let data;
        for (let attempt = 0; ; attempt++) {
            await gate();
            try {
                const res = await post(`${endpoint}/sources_to_targets`, body,
                    { timeout: timeoutMs, validateStatus: () => true });
                if (res && res.status >= 500) {
                    throw new ValhallaUnavailableError(`Valhalla returned HTTP ${res.status}`, res.status);
                }
                data = res && res.data;
                break;
            } catch (err) {
                if (attempt >= RETRY_DELAYS_MS.length) {
                    throw new ValhallaUnavailableError(
                        `Valhalla request failed: ${err && err.message}`, err && err.status);
                }
                await (opts.sleepFn || sleep)(RETRY_DELAYS_MS[attempt]);
            }
        }

        // One source, so one row. Anything else means the service answered with
        // something we do not understand, and inventing distances would be worse
        // than leaving the chunk null.
        const row = data && Array.isArray(data.sources_to_targets) && data.sources_to_targets[0];
        if (!Array.isArray(row)) continue;

        for (const cell of row) {
            const i = cell && cell.to_index;
            if (!Number.isInteger(i) || i < 0 || i >= chunk.length) continue;
            // Valhalla reports an unreachable pair as null distance/time, which is a
            // real fact about the pair rather than a failure to ask.
            if (!Number.isFinite(cell.distance) || !Number.isFinite(cell.time)) continue;
            out[start + i] = {
                km: cell.distance,          // already kilometres, per units above
                minutes: cell.time / 60,    // time is seconds
                geometry: null,
            };
        }
    }
    return out;
}

/** One leg, for parity with the other backends. Prefer fetchLegsFrom. */
async function fetchLeg(_token, from, to, opts = {}) {
    const [leg] = await fetchLegsFrom(null, from, [to], opts);
    return leg || null;
}

/** Is the local instance up and actually routing? Never throws. */
async function healthCheck(opts = {}) {
    const endpoint = opts.endpoint || DEFAULT_ENDPOINT;
    const post = opts.http || ((u, b, c) => axios.post(u, b, c));
    try {
        const res = await post(`${endpoint}/sources_to_targets`, {
            sources: [{ lat: 12.9716, lon: 77.5946 }],
            targets: [{ lat: 13.1986, lon: 77.7066 }],
            costing: COSTING,
            units: 'kilometers',
        }, { timeout: 8000, validateStatus: () => true });
        const cell = res && res.data && res.data.sources_to_targets
            && res.data.sources_to_targets[0] && res.data.sources_to_targets[0][0];
        return !!(cell && Number.isFinite(cell.distance));
    } catch (_) {
        return false;
    }
}

module.exports = {
    fetchLegsFrom,
    fetchLeg,
    healthCheck,
    ValhallaUnavailableError,
    PROFILE,
    PROVIDER,
    COSTING,
    DEFAULT_ENDPOINT,
    MAX_TARGETS,
};
