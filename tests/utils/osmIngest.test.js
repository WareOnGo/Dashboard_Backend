const { normalise, coordsOf, parseAge, gridRegions, runPool, simplify } = require('../../scripts/importOsmPois');
const { categoryFor } = require('../../src/utils/osmCategories');

/**
 * The pure half of scripts/importOsmPois.js — the part that turns an Overpass
 * response into rows. Requiring the script does not run it (the body is behind a
 * `require.main === module` guard), so this needs no database and no network.
 *
 * These target the normalisation bugs that produce a run which reports success
 * while storing nothing, or worse, storing something subtly wrong.
 */

describe('coordsOf', () => {
    test('reads a node\'s own coordinates', () => {
        expect(coordsOf({ type: 'node', lat: 12.9, lon: 77.6 })).toEqual({ lat: 12.9, lng: 77.6 });
    });

    test('reads the centre of a way fetched with `out center`', () => {
        // Ways and relations have no coordinates of their own, so without `center`
        // they arrive unusable. Hospitals and seaports are frequently mapped as
        // areas, which is why this path matters.
        expect(coordsOf({ type: 'way', center: { lat: 19.1, lon: 72.9 } }))
            .toEqual({ lat: 19.1, lng: 72.9 });
    });

    test('is null for a way with no centre, rather than guessing', () => {
        // This is what `out tags` produces. Returning a bogus 0,0 would put the POI
        // in the Gulf of Guinea and make it the "nearest" to nothing.
        expect(coordsOf({ type: 'way', id: 1 })).toBeNull();
    });

    test('rejects non-finite coordinates', () => {
        expect(coordsOf({ type: 'node', lat: NaN, lon: 77 })).toBeNull();
        expect(coordsOf({ type: 'node', lat: null, lon: null })).toBeNull();
    });
});

describe('normalise — points', () => {
    const fuel = categoryFor('fuel');
    const SOURCE = 'overpass:test:fuel:national:2026-09-01';

    test('maps element type to the single-character osmType', () => {
        const { rows } = normalise(fuel, [
            { type: 'node', id: 1, lat: 1, lon: 2, tags: { name: 'A' } },
            { type: 'way', id: 2, center: { lat: 3, lon: 4 }, tags: { name: 'B' } },
            { type: 'relation', id: 3, center: { lat: 5, lon: 6 }, tags: { name: 'C' } },
        ], SOURCE);

        expect(rows.map((r) => r.osmType)).toEqual(['n', 'w', 'r']);
    });

    test('keeps lat and lng in the right columns', () => {
        // Overpass says `lon`, this codebase says `lng`, and Mapbox URLs are
        // lng-first. A transposition here is silent and puts every POI in the
        // wrong hemisphere.
        const { rows } = normalise(fuel, [{ type: 'node', id: 1, lat: 12.9716, lon: 77.5946 }], SOURCE);
        expect(rows[0].lat).toBeCloseTo(12.9716);
        expect(rows[0].lng).toBeCloseTo(77.5946);
    });

    test('counts elements without coordinates instead of storing them', () => {
        const { rows, noCoords } = normalise(fuel, [
            { type: 'node', id: 1, lat: 1, lon: 2 },
            { type: 'way', id: 2 },
        ], SOURCE);

        expect(rows).toHaveLength(1);
        expect(noCoords).toBe(1);
    });

    test('osmId is a BigInt, because OSM ids overflow a 32-bit integer', () => {
        const { rows } = normalise(fuel, [
            { type: 'node', id: 11122233344455, lat: 1, lon: 2 },
        ], SOURCE);
        expect(typeof rows[0].osmId).toBe('bigint');
        expect(rows[0].osmId).toBe(11122233344455n);
    });

    test('an unnamed POI gets a null name, never a placeholder', () => {
        const { rows } = normalise(fuel, [{ type: 'node', id: 1, lat: 1, lon: 2, tags: {} }], SOURCE);
        expect(rows[0].name).toBeNull();
    });

    test('stores the full tag blob, and an empty object when there are none', () => {
        const { rows } = normalise(fuel, [
            { type: 'node', id: 1, lat: 1, lon: 2, tags: { brand: 'IOC', 'fuel:HGV_diesel': 'yes' } },
            { type: 'node', id: 2, lat: 3, lon: 4 },
        ], SOURCE);

        expect(rows[0].tags).toEqual({ brand: 'IOC', 'fuel:HGV_diesel': 'yes' });
        expect(rows[1].tags).toEqual({});
    });

    test('stamps the provenance string on every row', () => {
        const { rows } = normalise(fuel, [{ type: 'node', id: 1, lat: 1, lon: 2 }], SOURCE);
        expect(rows[0].sourceFile).toBe(SOURCE);
    });

    test('applies the category filter and reports what it dropped', () => {
        // The drop count is what makes a filter's behaviour auditable — invisible in
        // a row total, obvious here. It is how the metro/railway split was verified
        // to partition rather than overlap.
        const railway = categoryFor('railway_station');
        const { rows, filtered } = normalise(railway, [
            { type: 'node', id: 1, lat: 1, lon: 2, tags: { railway: 'station' } },
            { type: 'node', id: 2, lat: 3, lon: 4, tags: { railway: 'station', subway: 'yes' } },
            { type: 'node', id: 3, lat: 5, lon: 6, tags: { railway: 'station', station: 'light_rail' } },
        ], SOURCE);

        expect(rows).toHaveLength(1);
        expect(filtered).toBe(2);
    });

    test('ignores an element of an unknown type rather than crashing', () => {
        const { rows } = normalise(fuel, [{ type: 'count', id: 0, tags: { total: '5' } }], SOURCE);
        expect(rows).toHaveLength(0);
    });
});

describe('normalise — highway lines', () => {
    const highway = categoryFor('national_highway');
    const SOURCE = 'overpass:test:national_highway:0.5/12.50/77.50:2026-09-01';

    const way = (id, geometry, tags = {}) => ({ type: 'way', id, geometry, tags });

    test('builds SRID-qualified WKT in lng-lat order', () => {
        // WKT is X Y, i.e. longitude first. Getting this backwards produces a line
        // in the wrong place that still parses, which is the worst kind of wrong.
        const { rows } = normalise(highway, [
            way(1, [{ lat: 12.9, lon: 77.5 }, { lat: 13.0, lon: 77.6 }], { ref: 'NH44', highway: 'trunk' }),
        ], SOURCE);

        expect(rows[0].wkt).toBe('SRID=4326;LINESTRING(77.5 12.9,77.6 13)');
    });

    test('drops the tag blob, because ref/highway/name are already columns', () => {
        // Measured at 252 bytes a row — more than the geometry — for tags nothing
        // reads. Null rather than {} so it stores as a SQL NULL, not a jsonb null.
        const { rows } = normalise(highway, [
            way(1, [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }], { ref: 'NH44', highway: 'trunk', source: 'survey' }),
        ], SOURCE);

        expect(rows[0].tags).toBeNull();
    });

    test('simplifies the stored geometry', () => {
        // Overpass returns ~13 vertices a way; the tolerance takes that to ~3 with a
        // measured 0.3 m typical effect on distance-to-road.
        const dense = Array.from({ length: 15 }, (_, i) => ({ lat: 12.9 + i * 0.001, lon: 77.5 + i * 0.001 }));
        const { rows } = normalise(highway, [way(1, dense)], SOURCE);

        const stored = rows[0].wkt.match(/,/g).length + 1;
        expect(stored).toBeLessThan(dense.length);
        // The endpoints must survive, or the road no longer reaches where it did.
        expect(rows[0].wkt).toContain('77.5 12.9');
        expect(rows[0].wkt).toContain('77.514 12.914');
    });

    test('keeps ref and highway class, and tolerates an unnumbered road', () => {
        // Roughly a quarter of Indian trunk ways carry no ref, measured. Null is
        // correct; the read side has to render an unnamed highway.
        const { rows } = normalise(highway, [
            way(1, [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }], { ref: 'NH48', highway: 'motorway' }),
            way(2, [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }], { highway: 'trunk' }),
        ], SOURCE);

        expect(rows[0]).toMatchObject({ ref: 'NH48', highway: 'motorway' });
        expect(rows[1].ref).toBeNull();
        expect(rows[1].highway).toBe('trunk');
    });

    test('drops a way with fewer than two distinct points, by either route', () => {
        // A zero-length linestring is not valid geometry and ST_GeogFromText would
        // reject the whole batch it is in.
        //
        // Two distinct rejection paths, asserted separately because they mean
        // different things operationally: keep() turns away a way that arrived with
        // too few points, while normalisation turns away one that DEGENERATES to too
        // few after duplicate vertices are collapsed. A spike in the second is a
        // data-quality signal about OSM; a spike in the first means our query is
        // asking for the wrong thing.
        const { rows, noCoords, filtered } = normalise(highway, [
            way(1, [{ lat: 1, lon: 2 }]),                              // filtered by keep()
            way(2, []),                                                // filtered by keep()
            way(3, [{ lat: 1, lon: 2 }, { lat: 1, lon: 2 }]),          // degenerates on dedupe
            way(4, [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }]),          // kept
        ], SOURCE);

        expect(rows).toHaveLength(1);
        expect(filtered).toBe(2);
        expect(noCoords).toBe(1);
    });

    test('collapses consecutive duplicate vertices but keeps the shape', () => {
        // These three points are collinear, so simplification legitimately reduces
        // them to the endpoints. What matters here is that the duplicates are gone
        // and the line still spans the same extent.
        const { rows } = normalise(highway, [
            way(1, [
                { lat: 1, lon: 1 }, { lat: 1, lon: 1 },
                { lat: 2, lon: 2 }, { lat: 3, lon: 3 }, { lat: 3, lon: 3 },
            ]),
        ], SOURCE);

        expect(rows[0].wkt).toBe('SRID=4326;LINESTRING(1 1,3 3)');
    });

    test('skips a vertex with non-finite coordinates without losing the way', () => {
        const { rows } = normalise(highway, [
            way(1, [{ lat: 1, lon: 1 }, { lat: null, lon: 2 }, { lat: 3, lon: 3 }]),
        ], SOURCE);

        expect(rows[0].wkt).toBe('SRID=4326;LINESTRING(1 1,3 3)');
    });

    test('state highways are ingested deliberately, not by accident', () => {
        // Previously SH only arrived when OSM happened to tag it as trunk: 12,858 NH
        // rows against 573 SH, measured. The ref column is what tells them apart.
        const { rows } = normalise(highway, [
            way(1, [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }], { ref: 'SH17', highway: 'secondary' }),
        ], SOURCE);

        expect(rows[0].ref).toBe('SH17');
    });

    test('produces no lat/lng columns — a line has no single point', () => {
        const { rows } = normalise(highway, [way(1, [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }])], SOURCE);
        expect(rows[0].lat).toBeUndefined();
        expect(rows[0].lng).toBeUndefined();
    });
});

describe('simplify', () => {
    test('collapses near-collinear points to the endpoints', () => {
        const line = Array.from({ length: 20 }, (_, i) => [i * 0.01, i * 0.01 + (i % 2 ? 1e-5 : 0)]);
        const out = simplify(line, 0.0005);

        expect(out).toHaveLength(2);
        // Endpoints are passed through untouched, jitter and all — simplification
        // removes vertices, it never moves the ones it keeps.
        expect(out[0]).toEqual(line[0]);
        expect(out[1]).toEqual(line[line.length - 1]);
    });

    test('always keeps both endpoints, so adjacent ways still meet', () => {
        const line = [[0, 0], [0.5, 0.0001], [1, 0]];
        const out = simplify(line, 0.0005);
        expect(out[0]).toEqual([0, 0]);
        expect(out[out.length - 1]).toEqual([1, 0]);
    });

    test('keeps a corner that matters', () => {
        // A right angle is the whole shape. Losing it would move the road.
        expect(simplify([[0, 0], [1, 0], [1, 1]], 0.0005)).toHaveLength(3);
    });

    test('leaves a two-point line alone', () => {
        expect(simplify([[0, 0], [1, 1]], 0.0005)).toEqual([[0, 0], [1, 1]]);
    });

    test('handles a way with thousands of vertices without blowing the stack', () => {
        // Some OSM ways are enormous, which is why the implementation is iterative.
        const big = Array.from({ length: 20000 }, (_, i) => [i * 1e-4, Math.sin(i / 50) * 0.01]);
        expect(() => simplify(big, 0.0005)).not.toThrow();
        expect(simplify(big, 0.0005).length).toBeLessThan(big.length);
    });

    test('a bigger tolerance never yields more points', () => {
        const line = Array.from({ length: 50 }, (_, i) => [i * 0.01, Math.sin(i / 5) * 0.02]);
        expect(simplify(line, 0.01).length).toBeLessThanOrEqual(simplify(line, 0.001).length);
    });
});

describe('parseAge', () => {
    test.each([
        ['30d', 30 * 86400e3],
        ['12h', 12 * 3600e3],
        ['90m', 90 * 60e3],
    ])('parses %s', (spec, expected) => {
        expect(parseAge(spec)).toBe(expected);
    });

    test.each([['', null], ['soon', null], ['30', null], ['30y', null]])(
        'is null for %s, so a bad flag never means "everything is stale"', (spec) => {
            expect(parseAge(spec)).toBeNull();
        },
    );
});

describe('gridRegions', () => {
    test('covers India with no gap between cells', () => {
        const cells = gridRegions(6);
        expect(cells.length).toBeGreaterThan(20);
        // Every cell's north/east must meet its neighbour's south/west.
        const souths = [...new Set(cells.map((c) => c.south))].sort((a, b) => a - b);
        for (let i = 1; i < souths.length; i++) {
            const below = cells.find((c) => c.south === souths[i - 1]);
            expect(below.north).toBeCloseTo(souths[i], 6);
        }
    });

    test('clamps the last cell to India\'s bounds instead of overshooting', () => {
        const cells = gridRegions(6);
        expect(Math.max(...cells.map((c) => c.north))).toBeCloseTo(37.5, 6);
        expect(Math.max(...cells.map((c) => c.east))).toBeCloseTo(97.5, 6);
    });

    test('tile keys encode the cell size, so a split can go finer', () => {
        expect(gridRegions(6)[0].tileKey).toMatch(/^6\//);
    });

    test('keys are unique', () => {
        const cells = gridRegions(6);
        expect(new Set(cells.map((c) => c.tileKey)).size).toBe(cells.length);
    });
});

describe('runPool', () => {
    test('preserves input order in the results', async () => {
        const out = await runPool([3, 1, 2], async (n) => {
            await new Promise((r) => setTimeout(r, n * 5));
            return n * 10;
        }, 3);
        expect(out).toEqual([30, 10, 20]);
    });

    test('never runs more than the configured concurrency at once', async () => {
        let live = 0;
        let peak = 0;
        await runPool([1, 2, 3, 4, 5, 6], async () => {
            live++; peak = Math.max(peak, live);
            await new Promise((r) => setTimeout(r, 5));
            live--;
        }, 2);
        expect(peak).toBe(2);
    });

    test('handles an empty list', async () => {
        expect(await runPool([], async () => 1, 4)).toEqual([]);
    });
});
