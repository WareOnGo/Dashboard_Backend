const axios = require('axios');

/**
 * Overpass API client for the bulk POI ingest.
 *
 * Separate from src/ppt/services/geospatialService.js on purpose. That module is a
 * per-export live-lookup service: a 5-minute in-memory cache, a 20s axios default,
 * and failures swallowed to null so a deck still renders. A bulk ingest wants the
 * opposite of all three — no cache, timeouts derived from the query itself, and
 * failures that are loud and recorded, because a swallowed failure here becomes a
 * permanent hole in the data that later reads as "no fire station within range".
 *
 * The one thing every reader of this file needs to know:
 *
 *   OVERPASS REPORTS QUERY TIMEOUTS AND OUT-OF-MEMORY AS HTTP 200.
 *
 * The body is `{ elements: [], remark: "runtime error: Query timed out ..." }`. A
 * client that reads `elements` and ignores `remark` records "there is nothing of
 * this category here" and moves on. That single missing check is the source of
 * every silent hole this ingest could produce, so `remark` is treated as a hard
 * error, always, and never as an empty result.
 */

/** Public instances shed load under whole-country queries; make the target swappable. */
const DEFAULT_ENDPOINT = process.env.OVERPASS_ENDPOINT
    || 'https://overpass-api.de/api/interpreter';

/**
 * OSM's usage policy asks for a contactable User-Agent on automated traffic, and
 * the public instance throttles anonymous clients harder. This is the rare case
 * where an address belongs in a request header — it is the point of the header.
 */
const DEFAULT_USER_AGENT = process.env.OVERPASS_USER_AGENT
    || 'WareOnGoPoiIngest/1.0 (+support@wareongo.com)';

const DEFAULT_RATE_PER_SEC = Number(process.env.OVERPASS_RATE_PER_SEC || 1);
const DEFAULT_ATTEMPTS = 6;

/** Server-side timeout to assume when a query does not declare one. */
const FALLBACK_QUERY_TIMEOUT_SEC = 180;

/**
 * Added to the query's own `[timeout:N]` to get the HTTP timeout. Without a margin
 * the client aborts a query the server is still happily working on, which burns
 * the server's effort and looks like a network fault.
 */
const HTTP_TIMEOUT_MARGIN_SEC = 30;

const RETRY_DELAYS_SEC = [5, 15, 45, 120, 300];

/** HTTP statuses worth another go: rate limiting and gateway/backend churn. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

class OverpassError extends Error {
    /**
     * @param {string} message
     * @param {object} meta
     * @param {boolean} meta.retryable
     * @param {string} meta.kind - 'remark' | 'http' | 'network' | 'malformed' | 'body'
     * @param {number} [meta.status]
     * @param {string} [meta.remark]
     */
    constructor(message, { retryable, kind, status, remark } = {}) {
        super(message);
        this.name = 'OverpassError';
        this.retryable = !!retryable;
        this.kind = kind;
        this.status = status;
        this.remark = remark;
    }
}

/** Minimum spacing between requests. */
class RateLimiter {
    constructor(requestsPerSecond) {
        this.delayMs = requestsPerSecond > 0 ? 1000 / requestsPerSecond : 0;
        this.next = 0;
    }

    /**
     * Reserves the next slot before awaiting it, so N concurrent callers space
     * themselves out instead of all reading the same `lastRequest` and firing
     * together. That difference matters here: the ingest runs a worker pool.
     */
    async throttle(sleep = defaultSleep) {
        if (this.delayMs === 0) return;
        const now = Date.now();
        const slot = Math.max(now, this.next);
        this.next = slot + this.delayMs;
        if (slot > now) await sleep(slot - now);
    }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The server-side timeout a query declares, so the HTTP timeout can outlast it. */
function queryTimeoutSec(ql) {
    const match = /\[timeout:\s*(\d+)\s*\]/.exec(ql);
    return match ? Number(match[1]) : FALLBACK_QUERY_TIMEOUT_SEC;
}

/**
 * `Retry-After` is either a delay in seconds or an HTTP date. Honour both, and
 * ignore anything unparsable rather than sleeping for NaN.
 */
function retryAfterMs(headers) {
    const raw = headers && (headers['retry-after'] || headers['Retry-After']);
    if (!raw) return null;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const when = Date.parse(raw);
    if (Number.isFinite(when)) return Math.max(0, when - Date.now());
    return null;
}

/**
 * Classify a response into a result or an error.
 *
 * Exported and pure so the `remark`-in-a-200 rule is unit-testable without a
 * network, which is the only way to keep it from being quietly regressed.
 *
 * @param {{status: number, data: any, headers?: object}} response
 * @returns {{elements: object[], remark: undefined}}
 * @throws {OverpassError}
 */
function interpretResponse(response) {
    const { status, data } = response;

    if (status === 400) {
        // Malformed Overpass QL. Retrying cannot help and would waste the
        // server's time six times over.
        throw new OverpassError('Overpass rejected the query as malformed (400)', {
            retryable: false, kind: 'malformed', status,
        });
    }

    if (status !== 200) {
        throw new OverpassError(`Overpass returned HTTP ${status}`, {
            retryable: RETRYABLE_STATUS.has(status), kind: 'http', status,
        });
    }

    if (!data || typeof data !== 'object' || !Array.isArray(data.elements)) {
        // An HTML error page, or a truncated body that parsed to something odd.
        throw new OverpassError('Overpass returned a body with no elements array', {
            retryable: true, kind: 'body', status,
        });
    }

    // See the file header. This is the check the whole module exists for.
    if (data.remark) {
        throw new OverpassError(`Overpass reported a runtime problem: ${data.remark}`, {
            retryable: true, kind: 'remark', status, remark: String(data.remark),
        });
    }

    return { elements: data.elements };
}

class OverpassClient {
    /**
     * @param {object} [options]
     * @param {string} [options.endpoint]
     * @param {number} [options.ratePerSec]
     * @param {string} [options.userAgent]
     * @param {number} [options.attempts] - total tries per query, including the first
     * @param {Function} [options.http] - injected for tests: (url, body, config) => response
     * @param {Function} [options.sleep] - injected for tests
     */
    constructor({
        endpoint = DEFAULT_ENDPOINT,
        ratePerSec = DEFAULT_RATE_PER_SEC,
        userAgent = DEFAULT_USER_AGENT,
        attempts = DEFAULT_ATTEMPTS,
        http = null,
        sleep = defaultSleep,
    } = {}) {
        this.endpoint = endpoint;
        this.userAgent = userAgent;
        this.attempts = Math.max(1, attempts);
        this.limiter = new RateLimiter(ratePerSec);
        this.sleep = sleep;
        this.http = http || ((url, body, config) => axios.post(url, body, config));
    }

    /** Host only, for log lines and the `sourceFile` provenance string. */
    get host() {
        try {
            return new URL(this.endpoint).host;
        } catch (_) {
            return this.endpoint;
        }
    }

    /**
     * Run one Overpass query.
     *
     * @param {string} ql - complete Overpass QL, including its `[timeout:N]`
     * @param {object} [opts]
     * @param {string} [opts.label] - for log lines only
     * @returns {Promise<{elements: object[], durationMs: number, bytes: number, endpoint: string, attempts: number}>}
     * @throws {OverpassError} when every attempt failed, or on the first
     *   non-retryable failure
     */
    async fetch(ql, { label = 'query' } = {}) {
        const httpTimeoutMs = (queryTimeoutSec(ql) + HTTP_TIMEOUT_MARGIN_SEC) * 1000;
        let lastError;

        for (let attempt = 1; attempt <= this.attempts; attempt++) {
            await this.limiter.throttle(this.sleep);
            const startedAt = Date.now();

            let response;
            try {
                response = await this.http(this.endpoint, ql, {
                    timeout: httpTimeoutMs,
                    headers: {
                        'Content-Type': 'text/plain; charset=utf-8',
                        'User-Agent': this.userAgent,
                    },
                    // Never throw on status: interpretResponse decides what a status
                    // means, and it has to be able to read the body first. An error
                    // status can still carry a `remark`, and a 200 can carry an HTML
                    // error page — both are only visible if the body survives.
                    validateStatus: () => true,
                    responseType: 'json',
                    // A large tile response must not be truncated into invalid JSON.
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                });
            } catch (err) {
                // Some HTTP clients (and axios, unless configured otherwise) throw
                // on a non-2xx. Recover the response so the body can still be read.
                if (err && err.response) {
                    response = err.response;
                } else {
                    lastError = new OverpassError(
                        `Overpass request failed: ${err && err.message}`,
                        { retryable: true, kind: 'network' },
                    );
                    if (attempt < this.attempts) {
                        await this.backoff(attempt, null, label, lastError);
                        continue;
                    }
                    throw lastError;
                }
            }

            try {
                const { elements } = interpretResponse(response);
                return {
                    elements,
                    durationMs: Date.now() - startedAt,
                    bytes: byteLength(response),
                    endpoint: this.endpoint,
                    attempts: attempt,
                };
            } catch (err) {
                lastError = err;
                if (!(err instanceof OverpassError) || !err.retryable) {
                    if (err.kind === 'malformed') {
                        console.error(`OverpassClient: ${label} was rejected as malformed. Query sent:\n${ql}`);
                    }
                    throw err;
                }
                if (attempt < this.attempts) {
                    await this.backoff(attempt, response.headers, label, err);
                    continue;
                }
            }
        }

        throw lastError;
    }

    /** Wait before the next attempt, preferring the server's own instruction. */
    async backoff(attempt, headers, label, err) {
        const advised = retryAfterMs(headers);
        const planned = RETRY_DELAYS_SEC[Math.min(attempt - 1, RETRY_DELAYS_SEC.length - 1)] * 1000;
        // Jitter so a pool of workers backing off together does not resynchronise
        // and hit the server as one burst.
        const jitter = Math.floor(Math.random() * 1000);
        const waitMs = (advised === null ? planned : Math.max(advised, planned)) + jitter;
        console.warn(
            `OverpassClient: ${label} attempt ${attempt} failed (${err.kind}${err.status ? ' ' + err.status : ''}), `
            + `retrying in ${Math.round(waitMs / 1000)}s`,
        );
        await this.sleep(waitMs);
    }
}

/** Response size, for the tile record. Best-effort: headers first, then the body. */
function byteLength(response) {
    const header = response.headers
        && (response.headers['content-length'] || response.headers['Content-Length']);
    if (header && Number.isFinite(Number(header))) return Number(header);
    try {
        return Buffer.byteLength(JSON.stringify(response.data));
    } catch (_) {
        return 0;
    }
}

module.exports = {
    OverpassClient,
    OverpassError,
    RateLimiter,
    interpretResponse,
    queryTimeoutSec,
    retryAfterMs,
    DEFAULT_ENDPOINT,
    DEFAULT_USER_AGENT,
    RETRYABLE_STATUS,
};
