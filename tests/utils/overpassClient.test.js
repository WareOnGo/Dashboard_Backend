const {
    OverpassClient,
    OverpassError,
    RateLimiter,
    interpretResponse,
    queryTimeoutSec,
    retryAfterMs,
} = require('../../src/utils/overpassClient');

/**
 * The POI ingest's correctness rests almost entirely on this client classifying
 * responses correctly, because every misclassification turns into missing data
 * rather than a visible failure — and missing data reads downstream as "there is
 * no fire station near this warehouse".
 *
 * No network here. The HTTP client is injected, so every branch including the ones
 * that only fire on a bad Overpass day is exercised on every run.
 */

const ok = (elements = [], extra = {}) => ({
    status: 200,
    data: { elements, ...extra },
    headers: {},
});

describe('interpretResponse', () => {
    test('returns the elements of a clean response', () => {
        expect(interpretResponse(ok([{ id: 1 }, { id: 2 }])).elements).toHaveLength(2);
    });

    test('an empty elements array is a real answer, not an error', () => {
        // A tile genuinely containing no ports must be distinguishable from a
        // failure, or the ingest can never record a trustworthy negative.
        expect(interpretResponse(ok([])).elements).toEqual([]);
    });

    // The single most important test in this file. Overpass reports query timeouts
    // and OOM as HTTP 200 with an empty elements array plus a remark. Treating that
    // as "nothing here" is how the ingest would silently lose whole regions.
    test('a 200 carrying a remark is an error, never an empty result', () => {
        expect(() => interpretResponse(ok([], {
            remark: 'runtime error: Query timed out in "query" at line 3',
        }))).toThrow(OverpassError);
    });

    test('a remark is retryable and keeps its text for the tile record', () => {
        try {
            interpretResponse(ok([], { remark: 'runtime error: Query run out of memory' }));
            throw new Error('should have thrown');
        } catch (err) {
            expect(err.kind).toBe('remark');
            expect(err.retryable).toBe(true);
            expect(err.remark).toContain('out of memory');
        }
    });

    test('a remark alongside partial elements still fails', () => {
        // Partial results are worse than none: they look plausible and are wrong.
        expect(() => interpretResponse(ok([{ id: 1 }], { remark: 'runtime error: timed out' })))
            .toThrow(OverpassError);
    });

    test.each([
        ['rate limited', 429],
        ['bad gateway', 502],
        ['unavailable', 503],
        ['gateway timeout', 504],
    ])('%s (%i) is retryable', (_label, status) => {
        try {
            interpretResponse({ status, data: {}, headers: {} });
            throw new Error('should have thrown');
        } catch (err) {
            expect(err.retryable).toBe(true);
            expect(err.status).toBe(status);
        }
    });

    test('a malformed query (400) is NOT retryable', () => {
        // Retrying a syntax error just wastes a donated server's time six times.
        try {
            interpretResponse({ status: 400, data: {}, headers: {} });
            throw new Error('should have thrown');
        } catch (err) {
            expect(err.kind).toBe('malformed');
            expect(err.retryable).toBe(false);
        }
    });

    test('an HTML error page served as 200 is an error, not an empty result', () => {
        expect(() => interpretResponse({
            status: 200,
            data: '<html><body>Error: too many requests</body></html>',
            headers: {},
        })).toThrow(OverpassError);
    });
});

describe('queryTimeoutSec', () => {
    test('reads the timeout the query declares', () => {
        expect(queryTimeoutSec('[out:json][timeout:300];node(1);out;')).toBe(300);
    });

    test('tolerates whitespace', () => {
        expect(queryTimeoutSec('[out:json][timeout: 45 ];')).toBe(45);
    });

    test('falls back when the query declares none', () => {
        expect(queryTimeoutSec('[out:json];node(1);out;')).toBe(180);
    });
});

describe('retryAfterMs', () => {
    test('reads a delay in seconds', () => {
        expect(retryAfterMs({ 'retry-after': '30' })).toBe(30000);
    });

    test('reads an HTTP date', () => {
        const when = new Date(Date.now() + 20000).toUTCString();
        expect(retryAfterMs({ 'retry-after': when })).toBeGreaterThan(15000);
    });

    test('ignores an unparsable value rather than sleeping for NaN', () => {
        expect(retryAfterMs({ 'retry-after': 'soon' })).toBeNull();
    });

    test('is null when absent', () => {
        expect(retryAfterMs({})).toBeNull();
    });
});

describe('RateLimiter', () => {
    test('spaces concurrent callers instead of releasing them together', async () => {
        // The ingest runs a worker pool, so the naive "compare against
        // lastRequest" limiter would let N workers all fire at once.
        const limiter = new RateLimiter(2);   // 500ms apart
        const waits = [];
        const sleep = (ms) => { waits.push(ms); return Promise.resolve(); };

        await Promise.all([
            limiter.throttle(sleep),
            limiter.throttle(sleep),
            limiter.throttle(sleep),
        ]);

        const slept = waits.filter((w) => w > 0);
        expect(slept).toHaveLength(2);
        expect(Math.round(slept[1] - slept[0])).toBeGreaterThanOrEqual(400);
    });

    test('does not throttle when the rate is unlimited', async () => {
        const limiter = new RateLimiter(0);
        const sleep = jest.fn();
        await limiter.throttle(sleep);
        expect(sleep).not.toHaveBeenCalled();
    });
});

describe('OverpassClient.fetch', () => {
    const client = (http, opts = {}) => new OverpassClient({
        http,
        sleep: () => Promise.resolve(),
        ratePerSec: 0,
        ...opts,
    });

    test('returns elements, timing and size on success', async () => {
        const http = jest.fn().mockResolvedValue(ok([{ id: 7 }]));
        const result = await client(http).fetch('[out:json][timeout:60];');

        expect(result.elements).toEqual([{ id: 7 }]);
        expect(result.attempts).toBe(1);
        expect(result.bytes).toBeGreaterThan(0);
    });

    test('retries a remark and succeeds on a later attempt', async () => {
        const http = jest.fn()
            .mockResolvedValueOnce(ok([], { remark: 'runtime error: Query timed out' }))
            .mockResolvedValueOnce(ok([{ id: 1 }]));

        const result = await client(http).fetch('[out:json][timeout:60];');

        expect(http).toHaveBeenCalledTimes(2);
        expect(result.attempts).toBe(2);
    });

    test('gives up after the configured attempts and throws the last error', async () => {
        const http = jest.fn().mockResolvedValue({ status: 504, data: {}, headers: {} });

        await expect(client(http, { attempts: 3 }).fetch('[out:json][timeout:60];'))
            .rejects.toThrow(/HTTP 504/);
        expect(http).toHaveBeenCalledTimes(3);
    });

    test('does not retry a malformed query', async () => {
        const http = jest.fn().mockResolvedValue({ status: 400, data: {}, headers: {} });

        await expect(client(http, { attempts: 6 }).fetch('[out:json];bad'))
            .rejects.toMatchObject({ kind: 'malformed' });
        expect(http).toHaveBeenCalledTimes(1);
    });

    test('reads the body of an error the HTTP client threw on', async () => {
        // Some clients throw on non-2xx. The body still matters, because it can
        // carry the remark that explains what happened.
        const thrown = Object.assign(new Error('Request failed'), {
            response: ok([], { remark: 'runtime error: Query timed out' }),
        });
        const http = jest.fn()
            .mockRejectedValueOnce(thrown)
            .mockResolvedValueOnce(ok([{ id: 1 }]));

        const result = await client(http).fetch('[out:json][timeout:60];');
        expect(result.elements).toHaveLength(1);
    });

    test('retries a network failure that carries no response', async () => {
        const http = jest.fn()
            .mockRejectedValueOnce(new Error('ECONNRESET'))
            .mockResolvedValueOnce(ok([]));

        const result = await client(http).fetch('[out:json][timeout:60];');
        expect(result.attempts).toBe(2);
    });

    test('derives the HTTP timeout from the query, with a margin', async () => {
        const http = jest.fn().mockResolvedValue(ok([]));
        await client(http).fetch('[out:json][timeout:300];');

        // 300s of server budget plus a 30s margin, so the client never aborts a
        // query the server is still working on.
        expect(http.mock.calls[0][2].timeout).toBe(330000);
    });

    test('sends a contactable User-Agent, as the OSM usage policy asks', async () => {
        const http = jest.fn().mockResolvedValue(ok([]));
        await client(http).fetch('[out:json][timeout:60];');

        expect(http.mock.calls[0][2].headers['User-Agent']).toMatch(/WareOnGo/);
    });

    test('never lets the HTTP client throw on status, so the body survives', async () => {
        const http = jest.fn().mockResolvedValue(ok([]));
        await client(http).fetch('[out:json][timeout:60];');

        expect(http.mock.calls[0][2].validateStatus(503)).toBe(true);
    });

    test('honours the endpoint override and exposes its host', async () => {
        const http = jest.fn().mockResolvedValue(ok([]));
        const c = client(http, { endpoint: 'https://overpass.kumi.systems/api/interpreter' });
        await c.fetch('[out:json][timeout:60];');

        expect(http.mock.calls[0][0]).toContain('kumi.systems');
        expect(c.host).toBe('overpass.kumi.systems');
    });
});
