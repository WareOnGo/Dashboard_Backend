const {
    contains,
    isSupported,
    labelFor,
    resolveTags,
} = require('../../src/utils/microMarketGeometry');

// A 10x10 box with its lower-left corner at (0, 0). Coordinates are [lon, lat].
const box = (minLon, minLat, size = 10) => ({
    type: 'Polygon',
    coordinates: [[
        [minLon, minLat],
        [minLon + size, minLat],
        [minLon + size, minLat + size],
        [minLon, minLat + size],
        [minLon, minLat],
    ]],
});

describe('microMarketGeometry', () => {
    describe('contains', () => {
        it('detects a point inside a simple polygon', () => {
            expect(contains(box(0, 0), 5, 5)).toBe(true);
        });

        it('rejects a point outside a simple polygon', () => {
            expect(contains(box(0, 0), 50, 50)).toBe(false);
            expect(contains(box(0, 0), -1, 5)).toBe(false);
        });

        it('does not confuse the lon/lat argument order', () => {
            // Box spans lon 70..80, lat 10..20. The point (lon=75, lat=15) is inside;
            // swapping the two would put it outside, which is the classic bug here.
            const b = { ...box(70, 10) };
            expect(contains(b, 75, 15)).toBe(true);
            expect(contains(b, 15, 75)).toBe(false);
        });

        it('treats a hole as outside the polygon', () => {
            const withHole = {
                type: 'Polygon',
                coordinates: [
                    box(0, 0, 10).coordinates[0],
                    // inner ring covering 4..6
                    [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
                ],
            };
            expect(contains(withHole, 1, 1)).toBe(true);   // inside outer, outside hole
            expect(contains(withHole, 5, 5)).toBe(false);  // inside the hole
        });

        it('supports MultiPolygon', () => {
            const multi = {
                type: 'MultiPolygon',
                coordinates: [box(0, 0).coordinates, box(100, 100).coordinates],
            };
            expect(contains(multi, 5, 5)).toBe(true);
            expect(contains(multi, 105, 105)).toBe(true);
            expect(contains(multi, 50, 50)).toBe(false);
        });

        it('unwraps a Feature around the geometry', () => {
            expect(contains({ type: 'Feature', geometry: box(0, 0) }, 5, 5)).toBe(true);
        });

        it('returns false for null/unsupported geometry rather than throwing', () => {
            expect(contains(null, 5, 5)).toBe(false);
            expect(contains({ type: 'Point', coordinates: [5, 5] }, 5, 5)).toBe(false);
            expect(contains({ type: 'Feature', geometry: null }, 5, 5)).toBe(false);
        });
    });

    describe('isSupported', () => {
        it('accepts Polygon and MultiPolygon, rejects anything else', () => {
            expect(isSupported(box(0, 0))).toBe(true);
            expect(isSupported({ type: 'MultiPolygon', coordinates: [] })).toBe(true);
            expect(isSupported({ type: 'LineString', coordinates: [] })).toBe(false);
            expect(isSupported(null)).toBe(false);
        });
    });

    describe('labelFor', () => {
        it('uses the name when present', () => {
            expect(labelFor({ id: 'abc', name: 'Nelamangala' })).toBe('Nelamangala');
        });

        it('falls back to the id for blank or whitespace-only names', () => {
            expect(labelFor({ id: 'abc', name: '' })).toBe('abc');
            expect(labelFor({ id: 'abc', name: '   ' })).toBe('abc');
            expect(labelFor({ id: 'abc' })).toBe('abc');
        });

        it('trims surrounding whitespace off a real name', () => {
            expect(labelFor({ id: 'abc', name: '  Hoskote ' })).toBe('Hoskote');
        });
    });

    describe('resolveTags', () => {
        const markets = [
            { id: 'a', name: 'Zeta', geometry: box(0, 0) },
            { id: 'b', name: 'Alpha', geometry: box(5, 5) },   // overlaps Zeta at 5..10
            { id: 'c', name: '', geometry: box(100, 100) },
        ];

        it('returns every containing polygon, sorted, for overlaps', () => {
            expect(resolveTags(markets, 7, 7)).toEqual(['Alpha', 'Zeta']);
        });

        it('returns a single tag when only one polygon contains the point', () => {
            expect(resolveTags(markets, 1, 1)).toEqual(['Zeta']);
        });

        it('returns an empty array when the point is outside every polygon', () => {
            expect(resolveTags(markets, 50, 50)).toEqual([]);
        });

        it('falls back to the id for an unnamed polygon', () => {
            expect(resolveTags(markets, 105, 105)).toEqual(['c']);
        });

        it('returns an empty array for missing or NaN coordinates', () => {
            expect(resolveTags(markets, null, 5)).toEqual([]);
            expect(resolveTags(markets, 5, null)).toEqual([]);
            expect(resolveTags(markets, undefined, undefined)).toEqual([]);
            expect(resolveTags(markets, NaN, 5)).toEqual([]);
        });

        it('de-duplicates identically named polygons', () => {
            const dupes = [
                { id: 'x', name: 'Same', geometry: box(0, 0) },
                { id: 'y', name: 'Same', geometry: box(0, 0) },
            ];
            expect(resolveTags(dupes, 5, 5)).toEqual(['Same']);
        });
    });
});
