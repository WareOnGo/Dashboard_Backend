const {
    fetchLeg, TokenBucket, PROFILE, DirectionsUnavailableError,
} = require('../../src/utils/mapboxDirections');

/**
 * The only module that spends money, so it is the only one the rest of the suite
 * mocks. These tests inject the HTTP client and make no real request.
 */

const routed = (distance, duration, geometry) => ({
    data: { routes: [{ distance, duration, ...(geometry ? { geometry } : {}) }] },
});

const capture = () => {
    const calls = [];
    const http = (url, config) => {
        calls.push({ url, config });
        return Promise.resolve(routed(39412, 5231));
    };
    return { calls, http };
};

describe('fetchLeg', () => {
    test('converts metres and seconds to km and minutes', async () => {
        const r = await fetchLeg('tok', { lat: 1, lng: 2 }, { lat: 3, lng: 4 },
            { http: () => Promise.resolve(routed(39412, 5231)) });

        expect(r.km).toBeCloseTo(39.412);
        expect(r.minutes).toBeCloseTo(87.18, 1);
    });

    /**
     * Mapbox coordinates are lng,lat — the reverse of how every row in this codebase
     * is written, and of the order the KNN query returns. A transposition here does
     * not error: it returns a perfectly plausible route between two other places.
     */
    test('sends coordinates lng-first, in Mapbox order', async () => {
        const { calls, http } = capture();
        await fetchLeg('tok', { lat: 12.9716, lng: 77.5946 }, { lat: 13.1986, lng: 77.7066 }, { http });

        expect(calls[0].url).toContain('/77.5946,12.9716;77.7066,13.1986');
    });

    test('asks for no geometry by default', async () => {
        // ~200 bytes instead of ~2 KB. Across the backfill's ~29,000 legs that is
        // ~50 MB not transferred for a field nothing reads.
        const { calls, http } = capture();
        await fetchLeg('tok', { lat: 1, lng: 2 }, { lat: 3, lng: 4 }, { http });

        expect(calls[0].url).toContain('overview=false');
        expect(calls[0].url).not.toContain('geometries');
    });

    test('asks for geometry when a caller draws the route', async () => {
        const { calls, http } = capture();
        await fetchLeg('tok', { lat: 1, lng: 2 }, { lat: 3, lng: 4 }, { overview: 'simplified', http });

        expect(calls[0].url).toContain('overview=simplified');
        expect(calls[0].url).toContain('geometries=polyline');
    });

    test('returns geometry when the response carries it', async () => {
        const r = await fetchLeg('tok', { lat: 1, lng: 2 }, { lat: 3, lng: 4 }, {
            overview: 'simplified',
            http: () => Promise.resolve(routed(1000, 600, 'abc123')),
        });
        expect(r.geometry).toBe('abc123');
    });

    /**
     * Measured: adding alternatives=true CHANGES the primary route returned
     * (88.4km/84min against 62.0km/97min for one pair). A stored number must not
     * depend on a flag unrelated to the question being asked.
     */
    test('never requests alternatives', async () => {
        const { calls, http } = capture();
        await fetchLeg('tok', { lat: 1, lng: 2 }, { lat: 3, lng: 4 }, { http });
        expect(calls[0].url).not.toContain('alternatives');
    });

    test('uses the reproducible driving profile, not traffic-aware', async () => {
        // driving-traffic measured more realistic but varies with when it is called,
        // so the same deck built twice would disagree with itself.
        expect(PROFILE).toBe('driving');
        const { calls, http } = capture();
        await fetchLeg('tok', { lat: 1, lng: 2 }, { lat: 3, lng: 4 }, { http });
        expect(calls[0].url).toContain('/mapbox/driving/');
        expect(calls[0].url).not.toContain('driving-traffic');
    });

    test('passes the timeout through', async () => {
        const { calls, http } = capture();
        await fetchLeg('tok', { lat: 1, lng: 2 }, { lat: 3, lng: 4 }, { timeoutMs: 1234, http });
        expect(calls[0].config.timeout).toBe(1234);
    });

    /**
     * Null means "Mapbox answered and there is no route" — an island, a pedestrian
     * zone. That is a real fact about the pair of points and the caller may record
     * it as one.
     */
    test.each([
        ['there are no routes', () => Promise.resolve({ status: 200, data: { routes: [] } })],
        ['the body is empty', () => Promise.resolve({ status: 200, data: {} })],
        ['there is no body', () => Promise.resolve({ status: 200 })],
        ['distance is not a number', () => Promise.resolve({ status: 200, ...routed('far', 600) })],
        ['duration is missing', () => Promise.resolve({ status: 200, data: { routes: [{ distance: 1000 }] } })],
    ])('returns null when %s', async (_label, http) => {
        expect(await fetchLeg('tok', { lat: 1, lng: 2 }, { lat: 3, lng: 4 }, { http })).toBeNull();
    });
});

/**
 * The distinction this section exists for: being THROTTLED is not the same as
 * there being NO ROUTE. Returning null for a 429 would have the backfill persist
 * "this landmark is unreachable" as a fact about the site, and nothing would ever
 * revisit it, because the row looks computed.
 */
describe('fetchLeg — unavailable vs unroutable', () => {
    // No real waiting: the retry LOGIC is what matters, not the wall clock.
    const fast = { sleepFn: () => Promise.resolve(), retryDelaysMs: [0, 0, 0] };

    test.each([[429], [500], [502], [503], [504]])(
        'HTTP %i throws rather than reporting no route', async (status) => {
            const http = () => Promise.resolve({ status, data: {}, headers: {} });
            await expect(fetchLeg('tok', { lat: 1, lng: 2 }, { lat: 3, lng: 4 }, { http, ...fast }))
                .rejects.toThrow(DirectionsUnavailableError);
        });

    test('a rate limit is retried and can succeed', async () => {
        let calls = 0;
        const http = () => {
            calls++;
            return Promise.resolve(calls === 1
                ? { status: 429, data: {}, headers: { 'retry-after': '0' } }
                : { status: 200, ...routed(1000, 600) });
        };
        const r = await fetchLeg('tok', { lat: 1, lng: 2 }, { lat: 3, lng: 4 }, { http, ...fast });
        expect(r.km).toBe(1);
        expect(calls).toBe(2);
    });

    test('a network fault is retried and can succeed', async () => {
        let calls = 0;
        const http = () => {
            calls++;
            if (calls === 1) return Promise.reject(new Error('ECONNRESET'));
            return Promise.resolve({ status: 200, ...routed(2000, 900) });
        };
        const r = await fetchLeg('tok', { lat: 1, lng: 2 }, { lat: 3, lng: 4 }, { http, ...fast });
        expect(r.km).toBe(2);
    });

    test('the error carries the status, so an operator can see why', async () => {
        const http = () => Promise.resolve({ status: 429, data: {}, headers: {} });
        try {
            await fetchLeg('tok', { lat: 1, lng: 2 }, { lat: 3, lng: 4 }, { http, ...fast });
            throw new Error('should have thrown');
        } catch (err) {
            expect(err.status).toBe(429);
            expect(err.retryable).toBe(true);
        }
    });

    test('the real backoff is slow enough to be worth injecting around', () => {
        // Guards the reason sleepFn exists: if these ever became trivial, the
        // production retry would be hammering a service that asked us to wait.
        const { RETRY_DELAYS_MS } = require('../../src/utils/mapboxDirections');
        expect(RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeGreaterThan(30000);
    });

    test('lets the response body through instead of throwing on status', async () => {
        // Without this, a 429 arrives as a thrown error with its Retry-After buried.
        const calls = [];
        const http = (url, config) => {
            calls.push(config);
            return Promise.resolve({ status: 200, ...routed(1000, 600) });
        };
        await fetchLeg('tok', { lat: 1, lng: 2 }, { lat: 3, lng: 4 }, { http });
        expect(calls[0].validateStatus(429)).toBe(true);
    });
});

describe('TokenBucket', () => {
    test('spaces callers to the configured rate', async () => {
        const waits = [];
        const sleep = (ms) => { waits.push(ms); return Promise.resolve(); };
        const bucket = new TokenBucket(120);   // 500ms apart

        await Promise.all([bucket.take(sleep), bucket.take(sleep), bucket.take(sleep)]);

        const slept = waits.filter((w) => w > 0);
        expect(slept).toHaveLength(2);
        expect(slept[1] - slept[0]).toBeGreaterThanOrEqual(400);
    });

    /**
     * Reserving the slot before awaiting is what makes a worker pool safe: the naive
     * "compare against lastRequest" form lets N workers all read the same value and
     * fire together, straight through the rate limit.
     */
    test('reserves slots so concurrent callers cannot bunch up', async () => {
        const bucket = new TokenBucket(60);   // 1s apart
        const sleeps = [];
        const sleep = (ms) => { sleeps.push(ms); return Promise.resolve(); };

        await Promise.all(Array.from({ length: 5 }, () => bucket.take(sleep)));

        const positive = sleeps.filter((s) => s > 0).sort((a, b) => a - b);
        expect(positive).toHaveLength(4);
        // Each successive caller waits about a second longer than the last.
        for (let i = 1; i < positive.length; i++) {
            expect(positive[i] - positive[i - 1]).toBeGreaterThanOrEqual(900);
        }
    });

    test('does not throttle when unlimited', async () => {
        const sleep = jest.fn();
        await new TokenBucket(0).take(sleep);
        expect(sleep).not.toHaveBeenCalled();
    });
});

/**
 * Multi-waypoint batching. Mapbox bills a route with up to 25 coordinates as ONE
 * request, but routes them as a chain — so the origin is interleaved back in and the
 * even-numbered legs are the star distances we want. Verified against separate
 * single-leg calls on real coordinates at 0.000 km difference, which is what makes
 * this a free saving rather than an accuracy trade.
 */
describe('fetchLegsFrom', () => {
    const { fetchLegsFrom, MAX_DESTS_PER_REQUEST } = require('../../src/utils/mapboxDirections');

    const legsResponse = (n) => ({
        status: 200,
        data: { routes: [{ legs: Array.from({ length: n }, (_, i) => ({ distance: (i + 1) * 1000, duration: (i + 1) * 60 })) }] },
    });

    test('interleaves the origin between destinations', async () => {
        let url;
        const http = (u) => { url = u; return Promise.resolve(legsResponse(5)); };
        await fetchLegsFrom('tok', { lat: 1, lng: 2 },
            [{ lat: 3, lng: 4 }, { lat: 5, lng: 6 }, { lat: 7, lng: 8 }], { http });

        expect(url).toContain('2,1;4,3;2,1;6,5;2,1;8,7');
    });

    test('returns the outbound legs, not the return trips', async () => {
        // legs 0, 2, 4 are origin->destination; 1 and 3 are the way back.
        const r = await fetchLegsFrom('tok', { lat: 1, lng: 2 },
            [{ lat: 3, lng: 4 }, { lat: 5, lng: 6 }, { lat: 7, lng: 8 }],
            { http: () => Promise.resolve(legsResponse(5)) });

        expect(r.map((x) => x.km)).toEqual([1, 3, 5]);
    });

    test('is positionally aligned with the destinations it was given', async () => {
        const r = await fetchLegsFrom('tok', { lat: 1, lng: 2 },
            [{ lat: 3, lng: 4 }, { lat: 5, lng: 6 }],
            { http: () => Promise.resolve(legsResponse(3)) });
        expect(r).toHaveLength(2);
    });

    test('chunks beyond the coordinate limit into several requests', async () => {
        // 2N+1 coordinates for N destinations, against a 25-coordinate ceiling.
        expect(MAX_DESTS_PER_REQUEST).toBe(12);
        let requests = 0;
        const http = () => { requests++; return Promise.resolve(legsResponse(23)); };
        const dests = Array.from({ length: 12 }, (_, i) => ({ lat: i, lng: i }));
        await fetchLegsFrom('tok', { lat: 0, lng: 0 }, dests, { http });
        expect(requests).toBe(1);
    });

    test('uses the plain two-point form for a single destination', async () => {
        let url;
        const http = (u) => { url = u; return Promise.resolve({ status: 200, ...routed(1000, 600) }); };
        const r = await fetchLegsFrom('tok', { lat: 1, lng: 2 }, [{ lat: 3, lng: 4 }], { http });

        expect(url).toContain('2,1;4,3');
        expect(url).not.toContain('2,1;4,3;2,1');
        expect(r[0].km).toBe(1);
    });

    /**
     * Mapbox rejects an ENTIRE multi-waypoint request when any single waypoint is
     * unroutable. Without a fallback, one island destination would cost us the other
     * eleven answers and they would all be recorded as unreachable.
     */
    test('falls back to individual legs when the batch is rejected', async () => {
        let calls = 0;
        const http = (url) => {
            calls++;
            // The batched request has interleaved coordinates; the singles do not.
            if (url.split(';').length > 2) return Promise.resolve({ status: 200, data: { routes: [] } });
            return Promise.resolve({ status: 200, ...routed(5000, 900) });
        };
        const r = await fetchLegsFrom('tok', { lat: 1, lng: 2 },
            [{ lat: 3, lng: 4 }, { lat: 5, lng: 6 }], { http });

        expect(calls).toBe(3);                       // one batch, then two singles
        expect(r.map((x) => x && x.km)).toEqual([5, 5]);
    });

    test('a leg count that does not match the request is treated as a rejection', async () => {
        let calls = 0;
        const http = (url) => {
            calls++;
            if (url.split(';').length > 2) return Promise.resolve(legsResponse(99));
            return Promise.resolve({ status: 200, ...routed(1000, 600) });
        };
        await fetchLegsFrom('tok', { lat: 1, lng: 2 },
            [{ lat: 3, lng: 4 }, { lat: 5, lng: 6 }], { http });
        expect(calls).toBe(3);
    });

    test('gates every request, so the rate limiter sees the real count', async () => {
        // Only this function knows how many requests a batch becomes, so a caller
        // cannot rate-limit it correctly from outside.
        let gated = 0;
        const dests = Array.from({ length: 24 }, (_, i) => ({ lat: i, lng: i }));
        await fetchLegsFrom('tok', { lat: 0, lng: 0 }, dests, {
            http: () => Promise.resolve(legsResponse(23)),
            onRequest: async () => { gated++; },
        });
        expect(gated).toBe(2);
    });

    test('an empty destination list makes no request at all', async () => {
        const http = jest.fn();
        expect(await fetchLegsFrom('tok', { lat: 1, lng: 2 }, [], { http })).toEqual([]);
        expect(http).not.toHaveBeenCalled();
    });
});

describe('fetchLegsFrom — chunk concurrency', () => {
    const { fetchLegsFrom } = require('../../src/utils/mapboxDirections');
    const legsResponse = (n) => ({
        status: 200,
        data: { routes: [{ legs: Array.from({ length: n }, (_, i) => ({ distance: (i + 1) * 1000, duration: (i + 1) * 60 })) }] },
    });

    /**
     * Chunks used to run one after another, so a warehouse needing five requests paid
     * five round trips end to end — measured at 7.8s per warehouse against about 1s
     * of actual rate-limited request time.
     */
    test('runs several chunks at once', async () => {
        let live = 0;
        let peak = 0;
        const http = async () => {
            live++; peak = Math.max(peak, live);
            await new Promise((r) => setTimeout(r, 5));
            live--;
            return legsResponse(23);
        };
        const dests = Array.from({ length: 48 }, (_, i) => ({ lat: i, lng: i }));
        await fetchLegsFrom('tok', { lat: 0, lng: 0 }, dests, { http });

        expect(peak).toBeGreaterThan(1);
    });

    test('respects an explicit concurrency ceiling', async () => {
        let live = 0;
        let peak = 0;
        const http = async () => {
            live++; peak = Math.max(peak, live);
            await new Promise((r) => setTimeout(r, 5));
            live--;
            return legsResponse(23);
        };
        const dests = Array.from({ length: 60 }, (_, i) => ({ lat: i, lng: i }));
        await fetchLegsFrom('tok', { lat: 0, lng: 0 }, dests, { http, chunkConcurrency: 2 });

        expect(peak).toBe(2);
    });

    test('still returns results in destination order', async () => {
        // Concurrency must not scramble the alignment with the input, or every
        // landmark would be attributed to the wrong category.
        const http = async (url) => {
            // Vary latency so a naive implementation would finish out of order.
            await new Promise((r) => setTimeout(r, url.length % 7));
            return legsResponse(23);
        };
        const dests = Array.from({ length: 36 }, (_, i) => ({ lat: i, lng: i }));
        const r = await fetchLegsFrom('tok', { lat: 0, lng: 0 }, dests, { http });

        expect(r).toHaveLength(36);
        // Each chunk of 12 reports legs 1,3,5..23 -> km 1,3,5..23, repeated per chunk.
        expect(r.slice(0, 3).map((x) => x.km)).toEqual([1, 3, 5]);
        expect(r.slice(12, 15).map((x) => x.km)).toEqual([1, 3, 5]);
    });

    test('gates every request even when chunks overlap', async () => {
        let gated = 0;
        const dests = Array.from({ length: 48 }, (_, i) => ({ lat: i, lng: i }));
        await fetchLegsFrom('tok', { lat: 0, lng: 0 }, dests, {
            http: () => Promise.resolve(legsResponse(23)),
            onRequest: async () => { gated++; },
        });
        expect(gated).toBe(4);
    });
});
