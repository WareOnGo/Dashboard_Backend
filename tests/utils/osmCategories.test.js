const {
    CATEGORIES,
    SCOPE_NATIONAL,
    SCOPE_GRID,
    SCOPE_FOOTPRINT,
    TARGET_POI,
    TARGET_HIGHWAY,
    categoryFor,
    categoryKeys,
    queryHash,
    nameFrom,
    maxVoltage,
    footprintBufferDeg,
} = require('../../src/utils/osmCategories');

/**
 * These are mostly assertions about Overpass QL, which is untestable in the usual
 * sense — you cannot check a query returns the right answer without asking the
 * server. What they can do is pin the mistakes that produce a silently WRONG
 * ingest rather than a failed one, because those are the expensive kind: the run
 * completes, the table fills, and the numbers are quietly incomplete.
 */

const ANY_BOX = '12.25,77.25,13.25,78.25';
const qlFor = (c) => c.ql(c.scope === SCOPE_NATIONAL ? null : ANY_BOX);

describe('every category', () => {
    test.each(CATEGORIES.map((c) => [c.key, c]))('%s is completely specified', (_key, c) => {
        expect([SCOPE_NATIONAL, SCOPE_GRID, SCOPE_FOOTPRINT]).toContain(c.scope);
        expect([TARGET_POI, TARGET_HIGHWAY]).toContain(c.target);
        expect(typeof c.ql).toBe('function');
        expect(c.timeoutSec).toBeGreaterThan(0);
        expect(Number.isFinite(c.minExpected)).toBe(true);
        expect(typeof c.mustExistNearWarehouses).toBe('boolean');
        if (c.scope === SCOPE_GRID) expect(c.gridDeg).toBeGreaterThan(0);
    });

    /**
     * `out tags;` omits coordinates. Every element would then be skipped for having
     * no lat/lng, the fetch would record "0 stored", and the category would vanish
     * from the table while every status said success. It is the single easiest way
     * to ship a broken ingest, so it is asserted rather than remembered.
     */
    test.each(CATEGORIES.map((c) => [c.key, c]))('%s never uses `out tags`', (_key, c) => {
        expect(qlFor(c)).not.toMatch(/out\s+tags\s*;/);
    });

    test.each(CATEGORIES.map((c) => [c.key, c]))('%s declares a timeout matching its config', (_key, c) => {
        // The HTTP timeout is derived from the query's own [timeout:N], so a
        // mismatch means the client gives up early or waits far too long.
        expect(qlFor(c)).toContain(`[timeout:${c.timeoutSec}]`);
    });

    test.each(CATEGORIES.map((c) => [c.key, c]))('%s emits geometry or a centre point', (_key, c) => {
        // Ways and relations have no lat/lng of their own; without `center` (or
        // `geom` for lines) they arrive unusable.
        expect(qlFor(c)).toMatch(/out\s+(center|geom)\s*;|out\s*;/);
    });

    test('keys are unique', () => {
        expect(new Set(categoryKeys()).size).toBe(CATEGORIES.length);
    });
});

describe('scope', () => {
    test('national queries are restricted to India', () => {
        CATEGORIES.filter((c) => c.scope === SCOPE_NATIONAL).forEach((c) => {
            expect(qlFor(c)).toContain('ISO3166-1');
        });
    });

    test('grid queries are restricted to India AND to their cell', () => {
        // Both: the area filter makes ocean cells return instantly, the bbox is
        // what actually splits the work.
        CATEGORIES.filter((c) => c.scope === SCOPE_GRID).forEach((c) => {
            const ql = c.ql(ANY_BOX);
            expect(ql).toContain('ISO3166-1');
            expect(ql).toContain(ANY_BOX);
        });
    });

    test('footprint queries use their bbox', () => {
        CATEGORIES.filter((c) => c.scope === SCOPE_FOOTPRINT).forEach((c) => {
            expect(c.ql(ANY_BOX)).toContain(ANY_BOX);
        });
    });

    test('only the two highway categories are footprint-scoped', () => {
        // Everything else is national, so its coverage has no edge. If a category
        // drifts into footprint scope, its "nearest" answers become silently
        // bounded by where we happen to own listings today.
        const footprint = CATEGORIES.filter((c) => c.scope === SCOPE_FOOTPRINT).map((c) => c.key);
        expect(footprint.sort()).toEqual(['highway_access', 'national_highway']);
    });
});

describe('category-specific rules that carry a decision', () => {
    test('aerodrome is filtered to real airports, not every airstrip', () => {
        // Measured: 401 bare aeroway=aerodrome in India, only 158 with an IATA code.
        const ql = qlFor(categoryFor('aerodrome'));
        expect(ql).toContain('"iata"');
        expect(ql).toMatch(/aerodrome:type/);
    });

    test('hospital does not quietly include clinics or doctors', () => {
        // Folding a primary health centre into "nearest hospital" makes the stored
        // distance answer a different question from its label.
        const ql = categoryFor('hospital').ql(ANY_BOX);
        expect(ql).not.toMatch(/amenity"?\s*=\s*"?(clinic|doctors)/);
    });

    test('bus_station does not include bus stops', () => {
        expect(categoryFor('bus_station').ql(null)).not.toContain('bus_stop');
    });

    test('national_highway asks for geometry, not a centre point', () => {
        // A way's bbox centre can be 100km from the warehouse. This is the bug in
        // the current export that the line table exists to fix.
        const ql = categoryFor('national_highway').ql(ANY_BOX);
        expect(ql).toMatch(/out\s+geom\s*;/);
        expect(ql).not.toMatch(/out\s+center\s*;/);
    });

    test('national_highway rejects a way with too few points to be a line', () => {
        const { keep } = categoryFor('national_highway');
        expect(keep({ geometry: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }] })).toBe(true);
        expect(keep({ geometry: [{ lat: 1, lon: 1 }] })).toBe(false);
        expect(keep({})).toBe(false);
    });

    test('highway_access looks for junctions and ramp intersections, not carriageway', () => {
        // Mapbox snaps to the carriageway and routes in from the nearest legal
        // entrance, so an arbitrary node on a motorway produces a nonsense number.
        const ql = categoryFor('highway_access').ql(ANY_BOX);
        expect(ql).toContain('motorway_junction');
        expect(ql).toContain('node.ln.mn');
    });

    test('railway_station excludes metro and light rail', () => {
        const { keep } = categoryFor('railway_station');
        expect(keep({ tags: { railway: 'station' } })).toBe(true);
        expect(keep({ tags: { station: 'subway' } })).toBe(false);
        expect(keep({ tags: { subway: 'yes' } })).toBe(false);
        expect(keep({ tags: { light_rail: 'yes' } })).toBe(false);
        expect(keep({ tags: { monorail: 'yes' } })).toBe(false);
    });

    test('substation keeps transmission class and drops distribution', () => {
        const { keep } = categoryFor('substation');
        expect(keep({ tags: { substation: 'transmission' } })).toBe(true);
        expect(keep({ tags: { substation: 'traction' } })).toBe(true);
        expect(keep({ tags: { voltage: '220000' } })).toBe(true);
        expect(keep({ tags: { voltage: '33000' } })).toBe(true);
        expect(keep({ tags: { voltage: '11000' } })).toBe(false);
        expect(keep({ tags: { substation: 'minor_distribution', voltage: '220000' } })).toBe(false);
        // No voltage tag at all: dropped, and the script reports the drop count so
        // this threshold can be tuned from evidence rather than guessed.
        expect(keep({ tags: {} })).toBe(false);
    });
});

describe('queryHash', () => {
    test('is stable across calls', () => {
        expect(queryHash('fuel')).toBe(queryHash('fuel'));
    });

    test('differs between categories', () => {
        const hashes = categoryKeys().map(queryHash);
        expect(new Set(hashes).size).toBe(hashes.length);
    });

    test('throws on an unknown category rather than returning a hash of nothing', () => {
        expect(() => queryHash('teleporter')).toThrow(/Unknown OSM category/);
    });

    test('covers keep(), not just the query text', () => {
        // Changing a filter changes what gets stored just as surely as changing the
        // query, so it has to invalidate the stored rows too.
        const c = categoryFor('substation');
        const before = queryHash('substation');
        const original = c.keep;
        c.keep = () => true;
        try {
            expect(queryHash('substation')).not.toBe(before);
        } finally {
            c.keep = original;
        }
    });
});

describe('nameFrom', () => {
    test.each([
        ['name', { name: 'Kempegowda International' }, 'Kempegowda International'],
        ['name:en fallback', { 'name:en': 'Bengaluru City' }, 'Bengaluru City'],
        ['ref as a last resort', { ref: 'NH44' }, 'NH44'],
    ])('reads %s', (_label, tags, expected) => {
        expect(nameFrom(tags)).toBe(expected);
    });

    /**
     * The current export does `element.tags?.name || 'Railway Station'`, which is
     * how you end up with fifty POIs all called "Railway Station" and a deck that
     * looks like it knows something it doesn't. Null, and let the renderer say
     * "unnamed".
     */
    test.each([
        ['no tags', {}],
        ['undefined', undefined],
        ['whitespace only', { name: '   ' }],
    ])('returns null for %s rather than a placeholder', (_label, tags) => {
        expect(nameFrom(tags)).toBeNull();
    });
});

describe('maxVoltage', () => {
    test('takes the highest of a semicolon list', () => {
        expect(maxVoltage('110000;220000;33000')).toBe(220000);
    });

    test('tolerates whitespace', () => {
        expect(maxVoltage(' 220000 ; 110000 ')).toBe(220000);
    });

    test.each([['missing', null], ['unparsable', 'high'], ['empty', '']])(
        'is null when %s', (_label, raw) => {
            expect(maxVoltage(raw)).toBeNull();
        },
    );
});

describe('footprintBufferDeg', () => {
    test('covers at least the radius it is given', () => {
        // 25km must not become 25 degrees, and must not round down to nothing.
        const deg = footprintBufferDeg(25);
        expect(deg * 111).toBeGreaterThanOrEqual(24.9);
        expect(deg).toBeLessThan(1);
    });

    test('scales with the radius', () => {
        expect(footprintBufferDeg(50)).toBeCloseTo(footprintBufferDeg(25) * 2, 6);
    });
});
