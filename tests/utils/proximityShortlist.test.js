const {
    guardCandidates, resolve, STATUS, WARNING, MAX_DIRECT_RATIO, DETOUR_RATIO_WARN,
} = require('../../src/utils/proximityShortlist');
const {
    CATEGORIES, METRIC_ROAD, METRIC_IDENTITY, proximityCategoryFor, proximityKeys,
} = require('../../src/utils/proximityCategories');

/**
 * The rule for "which landmark wins" and "what does an absence mean".
 *
 * Pure, so every branch runs on every test run — including the ones that only
 * happen when routing fails, which is exactly where a silently wrong answer would
 * otherwise hide.
 */

const cand = (id, directM, extra = {}) => ({
    poiSource: 'osm_poi', poiId: String(id), name: `P${id}`,
    lat: 12 + id / 100, lng: 77 + id / 100, directM, ...extra,
});
const hospital = proximityCategoryFor('hospital');
const highway = proximityCategoryFor('national_highway');

describe('guardCandidates', () => {
    test('keeps candidates that could still win by road', () => {
        // Within 1.7x of the nearest, so the road network could reorder them.
        const kept = guardCandidates([cand(1, 1000), cand(2, 1600)]);
        expect(kept).toHaveLength(2);
    });

    test('drops candidates that cannot win, to avoid paying to measure them', () => {
        const kept = guardCandidates([cand(1, 1000), cand(2, 1600), cand(3, 5000)]);
        expect(kept.map((c) => c.poiId)).toEqual(['1', '2']);
    });

    test('never drops the nearest, so a non-empty input never becomes empty', () => {
        expect(guardCandidates([cand(1, 9999)])).toHaveLength(1);
    });

    test('survives a landmark sitting exactly on the warehouse', () => {
        // A zero nearest distance would make every ratio infinite. Nothing can beat
        // a landmark at zero metres anyway.
        const kept = guardCandidates([cand(1, 0), cand(2, 500)]);
        expect(kept).toHaveLength(1);
        expect(kept[0].poiId).toBe('1');
    });

    test.each([[null], [undefined], [[]]])('handles %p', (input) => {
        expect(guardCandidates(input)).toEqual([]);
    });

    test('the ratio is documented and bounded, not arbitrary', () => {
        // Derived from measured road/direct ratios of 1.45-1.9, widened to
        // [1.2, 2.0]: worst possible swing between two candidates is 1.67.
        expect(MAX_DIRECT_RATIO).toBeGreaterThan(1.67);
        expect(MAX_DIRECT_RATIO).toBeLessThan(2);
    });
});

describe('resolve — the routed case', () => {
    /**
     * The single most important test here. If it can pass with one candidate, the
     * shortlist is pointless and the whole k>1 design is unjustified. Measured on
     * real data, this case occurred in 6 of 50 rows.
     */
    test('the winner is chosen by ROAD distance, not straight-line order', () => {
        const r = resolve({
            category: hospital,
            candidates: [cand(1, 1000), cand(2, 1500)],
            legs: [{ km: 9, minutes: 20 }, { km: 4, minutes: 10 }],
        });

        expect(r.landmarkName).toBe('P2');
        expect(r.roadKm).toBe(4);
        expect(r.warnings).toContain(WARNING.NEAREST_BY_ROAD_DIFFERS);
    });

    test('does not flag a difference when the nearest by line also wins by road', () => {
        const r = resolve({
            category: hospital,
            candidates: [cand(1, 1000), cand(2, 1500)],
            legs: [{ km: 3, minutes: 8 }, { km: 7, minutes: 15 }],
        });
        expect(r.landmarkName).toBe('P1');
        expect(r.warnings).not.toContain(WARNING.NEAREST_BY_ROAD_DIFFERS);
    });

    test('rounds to a precision a deck can print', () => {
        const r = resolve({
            category: hospital,
            candidates: [cand(1, 1000)],
            legs: [{ km: 4.26789, minutes: 11.7 }],
        });
        expect(r.roadKm).toBe(4.3);
        expect(r.driveMinutes).toBe(12);
    });

    test('carries the winning landmark\'s identity for auditing', () => {
        const r = resolve({
            category: hospital,
            candidates: [cand(7, 1000)],
            legs: [{ km: 4, minutes: 10 }],
        });
        expect(r).toMatchObject({ poiSource: 'osm_poi', poiId: '7' });
        expect(r.poiLat).toBeCloseTo(12.07);
    });

    test('an unroutable candidate is skipped but does not spoil the answer', () => {
        const r = resolve({
            category: hospital,
            candidates: [cand(1, 1000), cand(2, 1400)],
            legs: [null, { km: 6, minutes: 14 }],
        });
        expect(r.status).toBe(STATUS.OK);
        expect(r.landmarkName).toBe('P2');
    });

    test('a leg with a non-finite distance is treated as no leg', () => {
        const r = resolve({
            category: hospital,
            candidates: [cand(1, 1000)],
            legs: [{ km: NaN, minutes: 10 }],
        });
        expect(r.status).toBe(STATUS.ROUTING_FAILED);
    });

    test('an unnamed landmark yields null, never a placeholder', () => {
        const r = resolve({
            category: hospital,
            candidates: [cand(1, 1000, { name: null })],
            legs: [{ km: 4, minutes: 10 }],
        });
        expect(r.landmarkName).toBeNull();
    });
});

describe('resolve — the states that are not OK', () => {
    /**
     * NONE_IN_RANGE has to be a stored row rather than an absent one. An absent row
     * means "never computed", so conflating them would make every future run
     * re-shortlist this category forever, and the backfill would never terminate.
     */
    test('nothing in range is a real answer, with no distance and no exception', () => {
        const r = resolve({ category: hospital, candidates: [] });
        expect(r.status).toBe(STATUS.NONE_IN_RANGE);
        expect(r.roadKm).toBeNull();
        expect(r.candidates).toBe(0);
    });

    test('never reports zero distance for an absent landmark', () => {
        // "0 km" on a deck would read as "next door" rather than "we found nothing".
        const r = resolve({ category: hospital, candidates: [] });
        expect(r.roadKm).not.toBe(0);
        expect(r.driveMinutes).not.toBe(0);
    });

    /**
     * "There is nothing there" and "we could not get there" are different facts
     * about a site, and only one of them is the site's problem.
     */
    test('all candidates unroutable is ROUTING_FAILED, not NONE_IN_RANGE', () => {
        const r = resolve({
            category: hospital,
            candidates: [cand(1, 1000), cand(2, 1200)],
            legs: [null, null],
        });
        expect(r.status).toBe(STATUS.ROUTING_FAILED);
        // The landmark is still named, so an operator can see what failed to route.
        expect(r.landmarkName).toBe('P1');
        expect(r.roadKm).toBeNull();
    });

    test('the four statuses are all distinct strings', () => {
        const values = Object.values(STATUS);
        expect(new Set(values).size).toBe(values.length);
    });
});

describe('resolve — identity-only categories', () => {
    /**
     * Highways are named but not measured, and the status says so explicitly rather
     * than leaving a reader to infer it from two null columns. 95.5% of India's
     * numbered-highway mileage is not access-controlled, so any distance we quoted
     * would describe a road you often cannot join at that point.
     */
    test('names the nearest without claiming a distance', () => {
        const r = resolve({
            category: highway,
            candidates: [{ poiSource: 'osm_highway', poiId: '9', name: 'NH48', lat: null, lng: null, directM: 800 }],
        });
        expect(r.status).toBe(STATUS.IDENTITY_ONLY);
        expect(r.landmarkName).toBe('NH48');
        expect(r.roadKm).toBeNull();
        expect(r.driveMinutes).toBeNull();
    });

    test('ignores any legs handed to it', () => {
        const r = resolve({
            category: highway,
            candidates: [{ poiSource: 'osm_highway', poiId: '9', name: 'NH48', lat: 1, lng: 2, directM: 800 }],
            legs: [{ km: 5, minutes: 12 }],
        });
        expect(r.roadKm).toBeNull();
    });

    test('still reports nothing in range when there is no highway nearby', () => {
        expect(resolve({ category: highway, candidates: [] }).status).toBe(STATUS.NONE_IN_RANGE);
    });
});

describe('bad-coordinate warnings', () => {
    test('flags a road distance implausibly larger than the straight line', () => {
        // 1 km apart, 5 km of road: a barrier, or coordinates in the wrong place.
        const r = resolve({
            category: hospital,
            candidates: [cand(1, 1000)],
            legs: [{ km: 5, minutes: 12 }],
        });
        expect(r.warnings).toContain(WARNING.DETOUR_RATIO_HIGH);
    });

    test('does not flag an ordinary detour', () => {
        // Measured Bengaluru ratios were 1.45-1.9; a 2x detour is unremarkable.
        const r = resolve({
            category: hospital,
            candidates: [cand(1, 1000)],
            legs: [{ km: 2, minutes: 6 }],
        });
        expect(r.warnings).toEqual([]);
    });

    test('the threshold is well clear of normal road-to-direct ratios', () => {
        expect(DETOUR_RATIO_WARN).toBeGreaterThan(2);
    });
});

describe('category configuration', () => {
    test.each(CATEGORIES.map((c) => [c.key, c]))('%s is fully specified', (_key, c) => {
        expect(c.label).toBeTruthy();
        expect([METRIC_ROAD, METRIC_IDENTITY]).toContain(c.metric);
        expect(c.maxRadiusKm).toBeGreaterThan(0);
        expect(c.candidates).toBeGreaterThan(0);
        expect(Number.isFinite(c.order)).toBe(true);
    });

    test('keys and display order are unique', () => {
        expect(new Set(proximityKeys()).size).toBe(CATEGORIES.length);
        expect(new Set(CATEGORIES.map((c) => c.order)).size).toBe(CATEGORIES.length);
    });

    test('identity categories shortlist exactly one candidate', () => {
        // Nothing is measured, so the straight-line nearest IS the answer and extra
        // candidates would be fetched for nothing.
        CATEGORIES.filter((c) => c.metric === METRIC_IDENTITY)
            .forEach((c) => expect(c.candidates).toBe(1));
    });

    test('routed categories shortlist more than one', () => {
        // Otherwise the road-beats-line case can never be discovered.
        CATEGORIES.filter((c) => c.metric === METRIC_ROAD)
            .forEach((c) => expect(c.candidates).toBeGreaterThan(1));
    });

    test('every proximity category has a matching ingest category', () => {
        // A proximity category naming a landmark type nothing ingests would silently
        // report NONE_IN_RANGE for every warehouse forever.
        const { categoryFor } = require('../../src/utils/osmCategories');
        CATEGORIES.forEach((c) => expect(categoryFor(c.key)).toBeDefined());
    });
});
