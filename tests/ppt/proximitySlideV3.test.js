const { proximityRows } = require('../../src/ppt/slides/v3/proximitySlideV3');
const { CATEGORIES, GROUPS } = require('../../src/utils/proximityCategories');
const { STATUS, WARNING } = require('../../src/utils/proximityShortlist');

/**
 * The connectivity slide's state-to-text mapping.
 *
 * warehouse_proximity stores a status precisely so a deck can tell five situations
 * apart: routed, named-without-a-distance, nothing in range, not routable, and never
 * computed. Rendering any two of them the same way throws away the distinction the
 * backfill exists to preserve — and a blank cell where a reader expects a number
 * reads as a broken deck rather than as an honest absence.
 */

const wh = (rows) => ({ id: 1, WarehouseProximity: rows });
const row = (category, extra) => ({
    category, status: STATUS.OK, roadKm: 5, driveMinutes: 12, landmarkName: 'X', ...extra,
});
const find = (rows, label) => rows.find((r) => r.label === label);

describe('proximityRows', () => {
    test('returns one row per configured category, in display order', () => {
        const rows = proximityRows(wh([]));
        expect(rows).toHaveLength(CATEGORIES.length);
        const orders = rows.map((r) => CATEGORIES.find((c) => c.label === r.label).order);
        expect(orders).toEqual([...orders].sort((a, b) => a - b));
    });

    test('every row carries a group the slide knows how to render', () => {
        proximityRows(wh([])).forEach((r) => expect(GROUPS).toContain(r.group));
    });

    test('a routed row shows distance and time in separate fields', () => {
        // Separate so the slide can right-align them into two numeric columns; a
        // single combined string was what made the first design hard to scan.
        const r = find(proximityRows(wh([row('hospital', { roadKm: 4.4, driveMinutes: 12 })])), 'Nearest hospital');
        expect(r.km).toBe('4.4 km');
        expect(r.time).toBe('12 min');
        expect(r.note).toBe('');
    });

    test('the landmark name is carried separately from its category', () => {
        const r = find(proximityRows(wh([row('hospital', { landmarkName: 'Government Hospital, Karpuru' })])), 'Nearest hospital');
        expect(r.name).toBe('Government Hospital, Karpuru');
        expect(r.label).toBe('Nearest hospital');
    });

    /**
     * THREE GENERATIONS OF HIGHWAY ROW COEXIST, and the slide must not confuse them.
     *
     * The category was METRIC_IDENTITY — named, never measured — because the only
     * available method was a shortlist of tagged access points, and OSM does not tag
     * the crossroads where you join an unrestricted highway. Routing the centreline
     * replaced that in Sep 2026, so rows now carry a real distance. A row written
     * before that still has status IDENTITY_ONLY and must keep rendering as a bare
     * designation rather than as a missing number.
     */
    test('a routed highway shows its designation, distance and time', () => {
        const r = find(proximityRows(wh([
            { category: 'national_highway', status: STATUS.OK, landmarkName: 'NH648', roadKm: 2.61, driveMinutes: 3, warnings: [] },
        ])), 'Nearest highway');
        expect(r.name).toBe('NH648');
        expect(r.km).toBe('2.6 km');
        expect(r.time).toBe('3 min');
        expect(r.note).toBe('');
    });

    test('an unmeasured highway row still shows its designation and no distance', () => {
        const r = find(proximityRows(wh([
            { category: 'national_highway', status: STATUS.IDENTITY_ONLY, landmarkName: 'NH44', roadKm: null, driveMinutes: null },
        ])), 'Nearest highway');
        expect(r.note).toBe('NH44');
        expect(r.km).toBe('');
        expect(r.time).toBe('');
    });

    /**
     * Access on the carriageway itself. The routed distance is genuinely zero and is
     * stored at the 0.01km floor, so the guard here is that the deck never prints
     * that floor: "0.01 km" turns the strongest version of this fact into what looks
     * like a rounding error.
     */
    test('a warehouse on the highway says so instead of printing a zero distance', () => {
        const r = find(proximityRows(wh([
            {
                category: 'national_highway', status: STATUS.OK, landmarkName: 'NH44',
                roadKm: 0.01, driveMinutes: 1, warnings: [WARNING.ON_HIGHWAY],
            },
        ])), 'Nearest highway');
        expect(r.name).toBe('NH44');
        expect(r.note).toBe('Direct access');
        expect(r.emphasis).toBe(true);
        expect(r.km).toBe('');
        expect(r.km).not.toContain('0.01');
    });

    test('the on-highway row is worded differently from every other highway state', () => {
        const hwy = (row) => find(proximityRows(wh([{ category: 'national_highway', ...row }])), 'Nearest highway');
        const notes = [
            hwy({ status: STATUS.OK, landmarkName: 'NH44', roadKm: 0.01, driveMinutes: 1, warnings: [WARNING.ON_HIGHWAY] }),
            hwy({ status: STATUS.IDENTITY_ONLY, landmarkName: 'NH44', roadKm: null, driveMinutes: null }),
            hwy({ status: STATUS.NONE_IN_RANGE, landmarkName: null, roadKm: null, driveMinutes: null }),
            hwy({ status: STATUS.ROUTING_FAILED, landmarkName: 'NH44', roadKm: null, driveMinutes: null }),
        ].map((r) => r.note);
        expect(new Set(notes).size).toBe(notes.length);
    });

    test('nothing in range names the radius that was searched', () => {
        const r = find(proximityRows(wh([
            { category: 'fuel', status: STATUS.NONE_IN_RANGE, roadKm: null, driveMinutes: null, landmarkName: null },
        ])), 'Nearest fuel station');
        const radius = CATEGORIES.find((c) => c.key === 'fuel').maxRadiusKm;
        expect(r.note).toBe(`None within ${radius} km`);
        expect(r.km).toBe('');
    });

    test('not routable is worded differently from nothing in range', () => {
        // "There is no hospital near here" and "we could not drive to it" are
        // different facts about a site, and only one is the site's problem.
        const notRoutable = find(proximityRows(wh([
            { category: 'hospital', status: STATUS.ROUTING_FAILED, roadKm: null, driveMinutes: null, landmarkName: 'Some Hospital' },
        ])), 'Nearest hospital');
        const noneInRange = find(proximityRows(wh([
            { category: 'hospital', status: STATUS.NONE_IN_RANGE, roadKm: null, driveMinutes: null, landmarkName: null },
        ])), 'Nearest hospital');
        expect(notRoutable.note).not.toBe(noneInRange.note);
    });

    test('a category with no stored row says so, rather than going blank', () => {
        const r = find(proximityRows(wh([])), 'Nearest hospital');
        expect(r.note).toBe('Not available');
    });

    /**
     * The single most important assertion here: all five situations must produce
     * text a reader can tell apart.
     */
    test('the five states render as five distinguishable strings', () => {
        const texts = [
            find(proximityRows(wh([row('hospital', { roadKm: 4, driveMinutes: 10 })])), 'Nearest hospital'),
            find(proximityRows(wh([{ category: 'national_highway', status: STATUS.IDENTITY_ONLY, landmarkName: 'NH44' }])), 'Nearest highway'),
            find(proximityRows(wh([{ category: 'hospital', status: STATUS.NONE_IN_RANGE }])), 'Nearest hospital'),
            find(proximityRows(wh([{ category: 'hospital', status: STATUS.ROUTING_FAILED, landmarkName: 'H' }])), 'Nearest hospital'),
            find(proximityRows(wh([])), 'Nearest hospital'),
        ].map((r) => `${r.km}|${r.time}|${r.note}`);

        expect(new Set(texts).size).toBe(5);
    });

    test('never renders a zero distance', () => {
        // A stored 0 would read as "next door" rather than "very close"; the backfill
        // floors any real route at 0.01 km and this must not undo that.
        const r = find(proximityRows(wh([row('hospital', { roadKm: 0.01, driveMinutes: 1 })])), 'Nearest hospital');
        expect(r.km).toBe('10 m');
        expect(r.km).not.toMatch(/^0 /);
    });

    test('sub-kilometre distances are shown in metres', () => {
        const r = find(proximityRows(wh([row('fuel', { roadKm: 0.4, driveMinutes: 2 })])), 'Nearest fuel station');
        expect(r.km).toBe('400 m');
    });

    test('long drives read as hours rather than a large minute count', () => {
        const r = find(proximityRows(wh([row('seaport', { roadKm: 350, driveMinutes: 412 })])), 'Nearest port');
        expect(r.time).toBe('6 h 52');
        expect(r.km).toBe('350 km');
    });

    test('tolerates a warehouse with no proximity relation at all', () => {
        expect(() => proximityRows({ id: 1 })).not.toThrow();
        expect(() => proximityRows(null)).not.toThrow();
    });
});
