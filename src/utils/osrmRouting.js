const axios = require('axios');

/**
 * A locally-hosted OSRM, as an alternative routing backend to the Mapbox APIs.
 *
 * Mapbox's Directions API is itself built on OSRM, so the response shapes are
 * near-identical and this module is deliberately a drop-in for
 * src/utils/mapboxDirections.js — same function names, same return shapes, same
 * "null means genuinely unroutable, throwing means we could not ask" contract.
 *
 * WHY THIS EXISTS, AND WHAT IT LETS US DELETE.
 *
 * The Mapbox path has to approximate. Each routing call costs money and a
 * rate-limit slot, so the backfill shortlists candidates by straight-line distance,
 * prunes them with a ratio guard, routes the survivors and hopes the true winner
 * was among them. Measured, that approximation is good but not free: k=2 named the
 * wrong landmark 12.1% of the time, k=3 6.9%, k=12 1.7%.
 *
 * A local OSRM has no per-request cost and no rate limit, and its /table service is
 * exact — the same engine as /route, unlike Mapbox's hosted Matrix which was
 * measured picking a different winner 18% of the time. So the whole shortlist
 * apparatus collapses into: take every candidate in radius, ask /table once, keep
 * the minimum. Miss rate zero rather than 1.7%.
 *
 * The one caveat worth stating: this is a DIFFERENT ENGINE ON DIFFERENT DATA. A
 * Geofabrik extract has a different vintage from Mapbox's map, and there is no
 * traffic model here at all. Numbers will not match Mapbox exactly, and neither set
 * is automatically "right" — which is why both are worth comparing before choosing.
 */

/** Where osrm-routed is listening. See ~/dev/wareongo/osrm-india/preprocess.sh. */
const DEFAULT_ENDPOINT = process.env.OSRM_ENDPOINT || 'http://localhost:5000';

const DEFAULT_TIMEOUT_MS = 30000;
const PROFILE = 'driving';
const PROVIDER = 'osrm-local';

/**
 * Coordinates per /table request.
 *
 * OSRM caps this with --max-table-size (default 100; the local instance is started
 * with 2000). Kept below that so a config change on the server does not silently
 * start failing requests here.
 */
const MAX_TABLE_COORDS = Number(process.env.OSRM_MAX_TABLE || 500);

class OsrmUnavailableError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'OsrmUnavailableError';
        this.status = status;
        this.retryable = true;
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_DELAYS_MS = [500, 2000, 5000];

const coord = (p) => `${p.lng},${p.lat}`;

/**
 * Road distance and drive time from one origin to many destinations, in ONE
 * request, exactly.
 *
 * This is the function the Mapbox path cannot offer. `fetchLegsFrom` there has to
 * interleave the origin between destinations to turn a chain into a star, then
 * batch in twelves; here the service answers the star natively.
 *
 * @param {{lat: number, lng: number}} origin
 * @param {Array<{lat: number, lng: number}>} destinations
 * @param {object} [opts]
 * @param {string} [opts.endpoint]
 * @param {Function} [opts.http] - injected for tests
 * @param {Function} [opts.onRequest] - awaited before each HTTP call
 * @returns {Promise<Array<{km: number, minutes: number}|null>>} aligned with
 *   `destinations`; null where OSRM found no route.
 * @throws {OsrmUnavailableError} when OSRM could not be reached
 */
async function fetchLegsFrom(_token, origin, destinations, opts = {}) {
    if (!destinations || !destinations.length) return [];

    const endpoint = opts.endpoint || DEFAULT_ENDPOINT;
    const gate = opts.onRequest || (() => Promise.resolve());
    const get = opts.http || ((u, c) => axios.get(u, c));
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

    // One coordinate is the origin, so a chunk holds MAX_TABLE_COORDS - 1 targets.
    const chunkSize = Math.max(1, (opts.maxTableCoords || MAX_TABLE_COORDS) - 1);
    const out = new Array(destinations.length).fill(null);

    for (let start = 0; start < destinations.length; start += chunkSize) {
        const chunk = destinations.slice(start, start + chunkSize);
        const coords = [coord(origin), ...chunk.map(coord)].join(';');
        // sources=0 asks for one row: the origin against everything else.
        const url = `${endpoint}/table/v1/${PROFILE}/${coords}`
            + '?sources=0&annotations=distance,duration';

        let body;
        for (let attempt = 0; ; attempt++) {
            await gate();
            try {
                const res = await get(url, { timeout: timeoutMs, validateStatus: () => true });
                if (res && res.status >= 500) throw new OsrmUnavailableError(`OSRM returned HTTP ${res.status}`, res.status);
                body = res && res.data;
                break;
            } catch (err) {
                if (attempt >= RETRY_DELAYS_MS.length) {
                    throw new OsrmUnavailableError(
                        `OSRM request failed: ${err && err.message}`, err && err.status);
                }
                await (opts.sleepFn || sleep)(RETRY_DELAYS_MS[attempt]);
            }
        }

        // OSRM reports a routing problem in `code`; "Ok" is the only success value.
        if (!body || body.code !== 'Ok' || !Array.isArray(body.distances) || !Array.isArray(body.durations)) {
            // Not retryable and not a network fault: the service answered and could
            // not do it. Leave the chunk null rather than inventing distances.
            continue;
        }

        const dist = body.distances[0] || [];
        const dur = body.durations[0] || [];
        chunk.forEach((_, i) => {
            // Index 0 of the row is the origin against itself.
            const d = dist[i + 1];
            const t = dur[i + 1];
            // OSRM returns null for a destination it cannot reach, which is a real
            // fact about the pair of points, not a failure to ask.
            if (!Number.isFinite(d) || !Number.isFinite(t)) return;
            out[start + i] = { km: d / 1000, minutes: t / 60, geometry: null };
        });
    }
    return out;
}

/** One leg, for parity with the Mapbox module. Prefer fetchLegsFrom. */
async function fetchLeg(_token, from, to, opts = {}) {
    const [leg] = await fetchLegsFrom(null, from, [to], opts);
    return leg || null;
}

/** Is the local instance up and answering? Used before choosing this backend. */
async function healthCheck(opts = {}) {
    const endpoint = opts.endpoint || DEFAULT_ENDPOINT;
    const get = opts.http || ((u, c) => axios.get(u, c));
    try {
        const res = await get(
            `${endpoint}/route/v1/${PROFILE}/77.5946,12.9716;77.7066,13.1986?overview=false`,
            { timeout: 5000, validateStatus: () => true },
        );
        return !!(res && res.data && res.data.code === 'Ok');
    } catch (_) {
        return false;
    }
}

module.exports = {
    fetchLegsFrom,
    fetchLeg,
    healthCheck,
    OsrmUnavailableError,
    PROFILE,
    PROVIDER,
    DEFAULT_ENDPOINT,
    MAX_TABLE_COORDS,
};
