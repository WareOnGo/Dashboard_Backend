const { fetchLeg, TokenBucket, PROFILE } = require('../../src/utils/mapboxDirections');

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
     * Returns null rather than throwing, so one bad leg never breaks the batch that
     * triggered it — the same contract as MicroMarketService.tagsForPoint.
     */
    test.each([
        ['the request throws', () => { throw new Error('ECONNRESET'); }],
        ['there are no routes', () => Promise.resolve({ data: { routes: [] } })],
        ['the body is empty', () => Promise.resolve({ data: {} })],
        ['there is no body', () => Promise.resolve({})],
        ['distance is not a number', () => Promise.resolve(routed('far', 600))],
        ['duration is missing', () => Promise.resolve({ data: { routes: [{ distance: 1000 }] } })],
    ])('returns null when %s', async (_label, http) => {
        expect(await fetchLeg('tok', { lat: 1, lng: 2 }, { lat: 3, lng: 4 }, { http })).toBeNull();
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
