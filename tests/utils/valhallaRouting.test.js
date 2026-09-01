const {
    fetchLegsFrom, fetchLeg, healthCheck, ValhallaUnavailableError, MAX_TARGETS,
} = require('../../src/utils/valhallaRouting');

/**
 * The local-Valhalla backend.
 *
 * Asserts it honours the SAME contract as the Mapbox and OSRM modules, because the
 * backfill must be able to swap between all three without the meaning of a result
 * changing. The load-bearing distinction: null means "answered, no route"; throwing
 * means "could not ask".
 */

const matrix = (cells) => ({ status: 200, data: { sources_to_targets: [cells] } });
const cell = (to_index, distance, time) => ({ to_index, distance, time });

describe('fetchLegsFrom', () => {
    test('asks sources_to_targets with one source and many targets', async () => {
        let url; let body;
        const http = (u, b) => { url = u; body = b; return Promise.resolve(matrix([cell(0, 1, 60)])); };
        await fetchLegsFrom(null, { lat: 12.97, lng: 77.59 }, [{ lat: 13.19, lng: 77.70 }], { http });

        expect(url).toContain('/sources_to_targets');
        expect(body.sources).toEqual([{ lat: 12.97, lon: 77.59 }]);
        expect(body.targets).toEqual([{ lat: 13.19, lon: 77.70 }]);
    });

    test('asks for kilometres, since the default is miles', async () => {
        // Getting this wrong would inflate every distance by 1.61 and look plausible.
        let body;
        const http = (_u, b) => { body = b; return Promise.resolve(matrix([cell(0, 1, 60)])); };
        await fetchLegsFrom(null, { lat: 1, lng: 2 }, [{ lat: 3, lng: 4 }], { http });
        expect(body.units).toBe('kilometers');
    });

    test('sends lat/lon objects, not the lng,lat strings the other backends use', async () => {
        // Valhalla says `lon`; this codebase says `lng`. A silent transposition here
        // returns a plausible route between two entirely different places.
        let body;
        const http = (_u, b) => { body = b; return Promise.resolve(matrix([cell(0, 1, 60)])); };
        await fetchLegsFrom(null, { lat: 12.9716, lng: 77.5946 }, [{ lat: 13.1, lng: 77.7 }], { http });

        expect(body.sources[0]).toEqual({ lat: 12.9716, lon: 77.5946 });
        expect(body.sources[0].lng).toBeUndefined();
    });

    test('converts time from seconds to minutes and keeps km as given', async () => {
        const r = await fetchLegsFrom(null, { lat: 1, lng: 2 }, [{ lat: 3, lng: 4 }],
            { http: () => Promise.resolve(matrix([cell(0, 39.412, 5231)])) });

        expect(r[0].km).toBeCloseTo(39.412);
        expect(r[0].minutes).toBeCloseTo(87.18, 1);
    });

    test('places results by to_index, not by arrival order', async () => {
        // Valhalla may return cells in any order; using position would silently
        // attribute each landmark to the wrong category.
        const r = await fetchLegsFrom(null, { lat: 0, lng: 0 },
            [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }, { lat: 3, lng: 3 }],
            { http: () => Promise.resolve(matrix([cell(2, 30, 1800), cell(0, 10, 600), cell(1, 20, 1200)])) });

        expect(r.map((x) => x.km)).toEqual([10, 20, 30]);
    });

    test('a null distance is a genuine "no route", not a failure', async () => {
        const r = await fetchLegsFrom(null, { lat: 0, lng: 0 },
            [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }],
            { http: () => Promise.resolve(matrix([cell(0, null, null), cell(1, 20, 1200)])) });

        expect(r[0]).toBeNull();
        expect(r[1].km).toBe(20);
    });

    test('an unrecognised body yields nulls rather than invented distances', async () => {
        const r = await fetchLegsFrom(null, { lat: 0, lng: 0 }, [{ lat: 1, lng: 1 }],
            { http: () => Promise.resolve({ status: 200, data: { error: 'No path could be found' } }) });
        expect(r).toEqual([null]);
    });

    test('a server error throws rather than reporting no route', async () => {
        await expect(fetchLegsFrom(null, { lat: 0, lng: 0 }, [{ lat: 1, lng: 1 }], {
            http: () => Promise.resolve({ status: 503, data: {} }),
            sleepFn: () => Promise.resolve(),
        })).rejects.toThrow(ValhallaUnavailableError);
    });

    test('a network fault is retried before giving up', async () => {
        let calls = 0;
        const http = () => {
            calls++;
            if (calls === 1) return Promise.reject(new Error('ECONNREFUSED'));
            return Promise.resolve(matrix([cell(0, 5, 300)]));
        };
        const r = await fetchLegsFrom(null, { lat: 0, lng: 0 }, [{ lat: 1, lng: 1 }],
            { http, sleepFn: () => Promise.resolve() });
        expect(r[0].km).toBe(5);
    });

    test('chunks large target lists so one timeout cannot lose everything', async () => {
        let requests = 0;
        const http = () => {
            requests++;
            return Promise.resolve(matrix([cell(0, 1, 60), cell(1, 2, 120)]));
        };
        const dests = Array.from({ length: 5 }, (_, i) => ({ lat: i, lng: i }));
        await fetchLegsFrom(null, { lat: 0, lng: 0 }, dests, { http, maxTargets: 2 });
        expect(requests).toBe(3);
    });

    test('gates every request so a caller can rate-limit', async () => {
        let gated = 0;
        const dests = Array.from({ length: 4 }, (_, i) => ({ lat: i, lng: i }));
        await fetchLegsFrom(null, { lat: 0, lng: 0 }, dests, {
            http: () => Promise.resolve(matrix([cell(0, 1, 60), cell(1, 2, 120)])),
            maxTargets: 2,
            onRequest: async () => { gated++; },
        });
        expect(gated).toBe(2);
    });

    test('an empty destination list makes no request', async () => {
        const http = jest.fn();
        expect(await fetchLegsFrom(null, { lat: 0, lng: 0 }, [], { http })).toEqual([]);
        expect(http).not.toHaveBeenCalled();
    });

    test('the chunk size is bounded', () => {
        expect(MAX_TARGETS).toBeGreaterThan(10);
        expect(MAX_TARGETS).toBeLessThanOrEqual(1000);
    });
});

describe('fetchLeg', () => {
    test('is the single-destination form', async () => {
        const r = await fetchLeg(null, { lat: 0, lng: 0 }, { lat: 1, lng: 1 },
            { http: () => Promise.resolve(matrix([cell(0, 4.27, 700)])) });
        expect(r.km).toBeCloseTo(4.27);
    });
});

describe('healthCheck', () => {
    test('is true when it routes', async () => {
        expect(await healthCheck({ http: () => Promise.resolve(matrix([cell(0, 30, 1800)])) })).toBe(true);
    });

    test('is false when down, without throwing', async () => {
        // It is used to CHOOSE a backend, so it must never be what breaks.
        expect(await healthCheck({ http: () => { throw new Error('ECONNREFUSED'); } })).toBe(false);
    });
});
