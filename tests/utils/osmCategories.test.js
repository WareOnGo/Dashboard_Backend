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
    parseRefs,
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
    test('aerodrome requires an IATA code and nothing looser', () => {
        // Measured: 401 bare aeroway=aerodrome in India, only 158 with IATA. Also
        // measured, which is why the looser clause is gone: accepting
        // aerodrome:type=public added 2 rows and made a flying club the "nearest
        // airport" to a Bengaluru warehouse instead of Kempegowda International.
        const ql = qlFor(categoryFor('aerodrome'));
        expect(ql).toContain('"iata"');
        expect(ql).not.toMatch(/aerodrome:type/);
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

    test('metro_station and railway_station partition the station set', () => {
        // Neither overlapping nor leaving a gap: a station must land in exactly one
        // of the two. Previously the metro ones were fetched and discarded.
        const rail = categoryFor('railway_station').keep;
        const metro = categoryFor('metro_station').keep;
        const stations = [
            { tags: { railway: 'station' } },
            { tags: { railway: 'station', station: 'subway' } },
            { tags: { railway: 'station', subway: 'yes' } },
            { tags: { railway: 'station', light_rail: 'yes' } },
            { tags: { railway: 'station', station: 'light_rail' } },
            { tags: { railway: 'station', monorail: 'yes' } },
            { tags: { railway: 'halt' } },
        ];
        stations.forEach((el) => {
            expect(rail(el) !== metro(el)).toBe(true);
        });
    });

    test('metro is not required to exist near a warehouse', () => {
        // Metro runs in about a dozen Indian cities. An empty region is a fact about
        // the country, not a truncated response.
        expect(categoryFor('metro_station').mustExistNearWarehouses).toBe(false);
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

    test.each([['dropTags', 'dropTags', false], ['simplifyDeg', 'simplifyDeg', 0.05]])(
        'responds to %s, because it changes what gets stored', (_label, field, value) => {
            // A row stored under a different value for either is exactly as stale as
            // one fetched by a different query, so the hash has to see it.
            const c = categoryFor('national_highway');
            const before = queryHash('national_highway');
            const original = c[field];
            c[field] = value;
            try {
                expect(queryHash('national_highway')).not.toBe(before);
            } finally {
                c[field] = original;
            }
        },
    );

    test('covers keep(), not just the query text', () => {
        // Changing a filter changes what gets stored just as surely as changing the
        // query, so it has to invalidate the stored rows too.
        const c = categoryFor('railway_station');
        const before = queryHash('railway_station');
        const original = c.keep;
        c.keep = () => true;
        try {
            expect(queryHash('railway_station')).not.toBe(before);
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

    /**
     * These are real OSM name tags, not placeholders we invented — mappers putting
     * the category in the name field. Measured across the ingest: 718 rows, led by
     * 308 fuel stations named "Petrol Pump" and 214 police stations named "Police
     * Station". "Nearest fuel station: Petrol Pump" reads as a bug and says nothing.
     */
    test.each([
        ['Fuel'], ['fuel'], ['  Fuel  '], ['Petrol Pump'], ['Petrol Station'],
        ['Hospital'], ['Bus Station'], ['Bus Stand'], ['Railway Station'],
        ['Police Station'], ['Fire Station'], ['Airport'], ['Substation'],
        ['unnamed'], ['N/A'],
    ])('rejects %s, a name that only restates the category', (name) => {
        expect(nameFrom({ name })).toBeNull();
    });

    /**
     * The rejection has to stay narrow, or it starts discarding the informative
     * names that make a deck useful.
     */
    test.each([
        ['Government Hospital, Karpuru'],
        ['Anekal Bus Stand'],
        ['Kempegowda International Airport'],
        ['Attibele Police Station'],
        ['Hospital Road'],
        ['Fuel Depot Whitefield'],
    ])('keeps %s', (name) => {
        expect(nameFrom({ name })).toBe(name);
    });
});

describe('parseRefs', () => {
    test.each([
        ['NH44', 'NH44'],
        ['NH 44', 'NH44'],
        ['NH-44', 'NH44'],
        ['nh44', 'NH44'],
        ['  NH44  ', 'NH44'],
        ['NH66A', 'NH66A'],
    ])('canonicalises %s to %s', (raw, expected) => {
        // OSM spells the same road several ways. Grouping or matching on the raw
        // string treats one highway as three.
        expect(parseRefs(raw).ref).toBe(expected);
    });

    test('splits a road carrying several designations', () => {
        // Measured on 641 of 15,724 ways. A naive read of this column yields
        // "NH44;NH75", which is neither designation and matches no query.
        expect(parseRefs('NH44;NH75').refs).toEqual(['NH44', 'NH75']);
    });

    test('prefers the designation an Indian reader recognises', () => {
        // NH44 and AH43 are the same road; nobody in India calls it AH43.
        expect(parseRefs('AH43;NH44').ref).toBe('NH44');
        // An expressway is the more useful fact when a road is both.
        expect(parseRefs('NE7;NH348').ref).toBe('NE7');
        expect(parseRefs('SH17;NH66').ref).toBe('NH66');
    });

    test('keeps every designation for matching, even the unpreferred one', () => {
        // Display uses `ref`; a query for "near AH43" still has to match.
        expect(parseRefs('AH43;NH44').refs).toEqual(['AH43', 'NH44']);
    });

    test('deduplicates spellings of the same designation', () => {
        expect(parseRefs('NH44;NH 44;nh-44').refs).toEqual(['NH44']);
    });

    test('is deterministic when class and number cannot separate two refs', () => {
        // Not "correct" so much as stable: the same input must not produce a
        // different display value on a later run.
        expect(parseRefs('NH75;NH44').ref).toBe(parseRefs('NH44;NH75').ref);
    });

    test('keeps a named road verbatim rather than mangling it', () => {
        // "Mumbai Ring Road" is not a designation and must not be forced into one.
        expect(parseRefs('Mumbai Ring Road').ref).toBe('Mumbai Ring Road');
    });

    test.each([['null', null], ['undefined', undefined], ['empty', ''], ['whitespace', '   ']])(
        'is null with an empty refs array for %s', (_label, raw) => {
            expect(parseRefs(raw)).toEqual({ ref: null, refs: [] });
        },
    );

    test('tolerates stray separators', () => {
        expect(parseRefs('NH44;;NH75').refs).toEqual(['NH44', 'NH75']);
        expect(parseRefs('NH44,NH75').refs).toEqual(['NH44', 'NH75']);
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
