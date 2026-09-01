const {
    fetchLegsFrom, fetchLeg, healthCheck, OsrmUnavailableError, MAX_TABLE_COORDS,
} = require('../../src/utils/osrmRouting');

/**
 * The local-OSRM backend, as a drop-in alternative to the Mapbox one.
 *
 * These assert it honours the SAME contract as src/utils/mapboxDirections.js,
 * because the backfill has to be able to swap between them without the meaning of a
 * result changing. In particular: null means "the service answered and there is no
 * route", throwing means "we could not ask" — conflating those is what would record
 * an outage as a fact about a warehouse.
 */

const table = (distances, durations) => ({
    status: 200,
    data: { code: 'Ok', distances: [distances], durations: [durations] },
});

describe('fetchLegsFrom', () => {
    test('asks the table service for one origin against many destinations', async () => {
        // The whole point: Mapbox needs the origin interleaved between destinations
        // to fake a star out of a chain. OSRM answers the star natively.
        let url;
        const http = (u) => { url = u; return Promise.resolve(table([0, 1000, 2000], [0, 60, 120])); };
        await fetchLegsFrom(null, { lat: 1, lng: 2 }, [{ lat: 3, lng: 4 }, { lat: 5, lng: 6 }], { http });

        expect(url).toContain('/table/v1/driving/2,1;4,3;6,5');
        expect(url).toContain('sources=0');
        expect(url).not.toContain('2,1;4,3;2,1');
    });

    test('converts metres and seconds, skipping the origin-to-itself cell', async () => {
        const r = await fetchLegsFrom(null, { lat: 1, lng: 2 },
            [{ lat: 3, lng: 4 }, { lat: 5, lng: 6 }],
            { http: () => Promise.resolve(table([0, 39412, 5000], [0, 5231, 600])) });

        expect(r[0].km).toBeCloseTo(39.412);
        expect(r[0].minutes).toBeCloseTo(87.18, 1);
        expect(r[1].km).toBeCloseTo(5);
    });

    test('is positionally aligned with the destinations given', async () => {
        const r = await fetchLegsFrom(null, { lat: 0, lng: 0 },
            [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }, { lat: 3, lng: 3 }],
            { http: () => Promise.resolve(table([0, 1000, 2000, 3000], [0, 60, 120, 180])) });
        expect(r.map((x) => x.km)).toEqual([1, 2, 3]);
    });

    test('a null cell is a genuine "no route", not a failure', async () => {
        // OSRM returns null for an unreachable destination — an island, a
        // pedestrian-only zone. The caller may record that as a fact.
        const r = await fetchLegsFrom(null, { lat: 0, lng: 0 },
            [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }],
            { http: () => Promise.resolve(table([0, null, 2000], [0, null, 120])) });

        expect(r[0]).toBeNull();
        expect(r[1].km).toBe(2);
    });

    test('a non-Ok response yields nulls rather than invented distances', async () => {
        const r = await fetchLegsFrom(null, { lat: 0, lng: 0 }, [{ lat: 1, lng: 1 }], {
            http: () => Promise.resolve({ status: 200, data: { code: 'NoSegment' } }),
        });
        expect(r).toEqual([null]);
    });

    /**
     * The distinction that matters most, and the same one the Mapbox module makes:
     * being unable to REACH the router is not the same as there being no route.
     */
    test('a server error throws rather than reporting no route', async () => {
        await expect(fetchLegsFrom(null, { lat: 0, lng: 0 }, [{ lat: 1, lng: 1 }], {
            http: () => Promise.resolve({ status: 503, data: {} }),
            sleepFn: () => Promise.resolve(),
        })).rejects.toThrow(OsrmUnavailableError);
    });

    test('a network fault is retried before giving up', async () => {
        let calls = 0;
        const http = () => {
            calls++;
            if (calls === 1) return Promise.reject(new Error('ECONNREFUSED'));
            return Promise.resolve(table([0, 1000], [0, 60]));
        };
        const r = await fetchLegsFrom(null, { lat: 0, lng: 0 }, [{ lat: 1, lng: 1 }],
            { http, sleepFn: () => Promise.resolve() });
        expect(r[0].km).toBe(1);
    });

    test('chunks beyond the table-size cap', async () => {
        // OSRM refuses a table larger than --max-table-size, so chunking is a
        // correctness requirement rather than an optimisation.
        let requests = 0;
        const http = () => {
            requests++;
            return Promise.resolve(table(new Array(5).fill(1000), new Array(5).fill(60)));
        };
        const dests = Array.from({ length: 8 }, (_, i) => ({ lat: i, lng: i }));
        await fetchLegsFrom(null, { lat: 0, lng: 0 }, dests, { http, maxTableCoords: 5 });
        expect(requests).toBe(2);
    });

    test('gates every request so a caller can rate-limit it', async () => {
        let gated = 0;
        const dests = Array.from({ length: 8 }, (_, i) => ({ lat: i, lng: i }));
        await fetchLegsFrom(null, { lat: 0, lng: 0 }, dests, {
            http: () => Promise.resolve(table(new Array(5).fill(1000), new Array(5).fill(60))),
            maxTableCoords: 5,
            onRequest: async () => { gated++; },
        });
        expect(gated).toBe(2);
    });

    test('an empty destination list makes no request', async () => {
        const http = jest.fn();
        expect(await fetchLegsFrom(null, { lat: 0, lng: 0 }, [], { http })).toEqual([]);
        expect(http).not.toHaveBeenCalled();
    });

    test('the configured table size stays under a sane ceiling', () => {
        // The server is started with --max-table-size 2000; staying below it means a
        // server config change cannot silently start rejecting our requests.
        expect(MAX_TABLE_COORDS).toBeLessThanOrEqual(2000);
        expect(MAX_TABLE_COORDS).toBeGreaterThan(50);
    });
});

describe('fetchLeg', () => {
    test('is the single-destination form of the same call', async () => {
        const r = await fetchLeg(null, { lat: 0, lng: 0 }, { lat: 1, lng: 1 },
            { http: () => Promise.resolve(table([0, 4270], [0, 700])) });
        expect(r.km).toBeCloseTo(4.27);
    });
});

describe('healthCheck', () => {
    test('is true when the service routes', async () => {
        expect(await healthCheck({ http: () => Promise.resolve({ status: 200, data: { code: 'Ok' } }) })).toBe(true);
    });

    test('is false when it is down, without throwing', async () => {
        // Used to CHOOSE a backend, so it must never be the thing that breaks.
        expect(await healthCheck({ http: () => { throw new Error('ECONNREFUSED'); } })).toBe(false);
    });
});
