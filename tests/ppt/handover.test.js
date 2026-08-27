const PptxGenJS = require('pptxgenjs');
const { formatHandover } = require('../../src/ppt/utils/handover');
const { generateIndexSlideV2 } = require('../../src/ppt/slides/v2/indexSlideV2');
const { generateIndexSlideGodamwale } = require('../../src/ppt/slides/godamwale/indexSlideGodamwale');
const { generateDetailedSlideV2 } = require('../../src/ppt/slides/v2/detailedSlideV2');
const { generateDetailedSlideGodamwale } = require('../../src/ppt/slides/godamwale/detailedSlideGodamwale');

// Fixed reference "today" so date-window assertions never drift with the clock.
const NOW = new Date('2026-08-13T00:00:00Z');

describe('formatHandover - VARIABLE lead times', () => {
    test('renders the lead time instead of claiming immediate availability', () => {
        // The live regression: warehouse 973 is VARIABLE / 2 MONTHS with a null
        // handoverDate, and used to render as 'Immediate'.
        expect(formatHandover({
            handoverType: 'VARIABLE',
            handoverLeadValue: 2,
            handoverLeadUnit: 'MONTHS',
            handoverDate: null,
        }, NOW)).toBe('2 months');
    });

    test.each([
        [15, 'DAYS', '15 days'],
        [1, 'DAYS', '1 day'],
        [3, 'WEEKS', '3 weeks'],
        [1, 'WEEKS', '1 week'],
        [6, 'MONTHS', '6 months'],
        [1, 'MONTHS', '1 month'],
    ])('%s %s renders as "%s"', (value, unit, expected) => {
        expect(formatHandover({
            handoverType: 'VARIABLE', handoverLeadValue: value, handoverLeadUnit: unit,
        }, NOW)).toBe(expected);
    });

    test('a zero-length lead time is immediate availability', () => {
        expect(formatHandover({
            handoverType: 'VARIABLE', handoverLeadValue: 0, handoverLeadUnit: 'DAYS',
        }, NOW)).toBe('Immediate');
    });

    test.each([
        ['a missing lead value', { handoverLeadValue: null, handoverLeadUnit: 'MONTHS' }],
        ['a missing lead unit', { handoverLeadValue: 2, handoverLeadUnit: null }],
        ['both missing', { handoverLeadValue: null, handoverLeadUnit: null }],
        ['a negative lead value', { handoverLeadValue: -2, handoverLeadUnit: 'MONTHS' }],
        ['a non-numeric lead value', { handoverLeadValue: 'soon', handoverLeadUnit: 'MONTHS' }],
        ['an enum value this build does not know', { handoverLeadValue: 2, handoverLeadUnit: 'QUARTERS' }],
    ])('falls back to "On request" given %s', (_label, fields) => {
        expect(formatHandover({ handoverType: 'VARIABLE', ...fields }, NOW)).toBe('On request');
    });

    test('never reports Immediate for an incomplete VARIABLE row', () => {
        // The whole point of the fix: a row asserting "not ready now" must not
        // render as ready now, whatever else is missing.
        expect(formatHandover({
            handoverType: 'VARIABLE', handoverLeadValue: null, handoverLeadUnit: null, handoverDate: null,
        }, NOW)).not.toBe('Immediate');
    });

    test('ignores handoverDate when the row is VARIABLE', () => {
        // A stale date left over from an earlier edit must not win over the
        // lead time the row is actually keyed on.
        expect(formatHandover({
            handoverType: 'VARIABLE',
            handoverLeadValue: 3,
            handoverLeadUnit: 'MONTHS',
            handoverDate: new Date('2027-01-01T00:00:00Z'),
        }, NOW)).toBe('3 months');
    });
});

describe('formatHandover - FIXED and legacy rows', () => {
    test('a far-future date renders as that date', () => {
        expect(formatHandover({
            handoverType: 'FIXED', handoverDate: new Date('2026-09-15T00:00:00Z'),
        }, NOW)).toBe('15 Sep 2026');
    });

    test('a past date reads as immediate', () => {
        expect(formatHandover({
            handoverType: 'FIXED', handoverDate: new Date('2026-01-01T00:00:00Z'),
        }, NOW)).toBe('Immediate');
    });

    test.each([
        ['the last day inside the two-week window', '2026-08-27T00:00:00Z', 'Immediate'],
        ['the first day outside it', '2026-08-28T00:00:00Z', '28 Aug 2026'],
    ])('%s -> %s', (_label, iso, expected) => {
        expect(formatHandover({ handoverType: 'FIXED', handoverDate: new Date(iso) }, NOW)).toBe(expected);
    });

    test('FIXED with no date on record reads as immediate, as before', () => {
        // 24 rows are in this state; behaviour is deliberately unchanged by
        // this fix and tracked as a backfill gap on the data side.
        expect(formatHandover({ handoverType: 'FIXED', handoverDate: null }, NOW)).toBe('Immediate');
    });

    test('a pre-migration row with a null handoverType takes the date path', () => {
        expect(formatHandover({
            handoverType: null, handoverDate: new Date('2026-09-15T00:00:00Z'),
        }, NOW)).toBe('15 Sep 2026');
        expect(formatHandover({ handoverType: null, handoverDate: null }, NOW)).toBe('Immediate');
    });

    test('an ISO string survives a serialization hop', () => {
        expect(formatHandover({ handoverType: 'FIXED', handoverDate: '2026-09-15' }, NOW)).toBe('15 Sep 2026');
    });

    test('unparseable legacy free text falls back to immediate', () => {
        expect(formatHandover({ handoverType: null, handoverDate: 'ready now' }, NOW)).toBe('Immediate');
    });

    test('a date is read on its stored UTC calendar day regardless of local offset', () => {
        // 00:00Z on the 15th is the 14th locally in the Americas; the deck must
        // still say the 15th, which is what was stored.
        const tz = process.env.TZ;
        try {
            process.env.TZ = 'America/Los_Angeles';
            expect(formatHandover({
                handoverType: 'FIXED', handoverDate: new Date('2026-09-15T00:00:00Z'),
            }, NOW)).toBe('15 Sep 2026');
        } finally {
            process.env.TZ = tz;
        }
    });
});

describe('formatHandover - argument tolerance', () => {
    test('null and undefined read as immediate', () => {
        expect(formatHandover(null, NOW)).toBe('Immediate');
        expect(formatHandover(undefined, NOW)).toBe('Immediate');
    });

    test('the pre-migration date-only call shape still works', () => {
        // Guards a missed call site: passing a bare Date must not silently
        // resolve to 'Immediate' via an undefined handoverType.
        expect(formatHandover(new Date('2026-09-15T00:00:00Z'), NOW)).toBe('15 Sep 2026');
        expect(formatHandover('2026-09-15', NOW)).toBe('15 Sep 2026');
    });

    test('defaults to the real clock when no reference date is given', () => {
        expect(formatHandover({ handoverType: 'FIXED', handoverDate: null })).toBe('Immediate');
        expect(formatHandover({
            handoverType: 'VARIABLE', handoverLeadValue: 2, handoverLeadUnit: 'MONTHS',
        })).toBe('2 months');
    });
});

// ---------------------------------------------------------------------------
// Render-level coverage: the unit tests above pin the string, these confirm it
// actually reaches the cell in every deck that shows handover.
// ---------------------------------------------------------------------------

// Walks a generated slide and collects every string it renders, flattening
// table rows and the array-valued cells the detailed decks use.
function collectText(slide) {
    const out = [];
    const push = (v) => {
        if (v == null) return;
        if (Array.isArray(v)) return v.forEach(push);
        if (typeof v === 'object') return push(v.text);
        out.push(String(v));
    };
    for (const obj of slide._slideObjects || []) {
        push(obj.text);
        for (const row of obj.arrTabRows || []) push(row);
    }
    return out;
}

const VARIABLE_WAREHOUSE = {
    id: 973,
    address: '123 Test Street, Test City, Test State',
    city: 'Test City',
    state: 'Test State',
    totalSpaceSqft: [10000],
    warehouseType: 'RCC',
    ratePerSqft: '25',
    handoverType: 'VARIABLE',
    handoverLeadValue: 2,
    handoverLeadUnit: 'MONTHS',
    handoverDate: null,
    WarehouseData: {},
    validPhotos: [],
};

const FIXED_WAREHOUSE = {
    ...VARIABLE_WAREHOUSE,
    id: 779,
    handoverType: 'FIXED',
    handoverLeadValue: null,
    handoverLeadUnit: null,
    handoverDate: new Date('2026-09-15T00:00:00Z'),
};

describe('handover text reaches every deck that renders it', () => {
    let pptx;

    beforeEach(() => {
        pptx = new PptxGenJS();
        pptx.layout = 'LAYOUT_WIDE';
    });

    describe.each([
        ['v2 index', (p, w) => generateIndexSlideV2(p, [w])],
        ['godamwale index', (p, w) => generateIndexSlideGodamwale(p, [w])],
        ['v2 detailed', (p, w) => generateDetailedSlideV2(p, w, [], 1)],
        ['godamwale detailed', (p, w) => generateDetailedSlideGodamwale(p, w, [], 1)],
    ])('%s slide', (_name, render) => {
        test('shows the lead time for a VARIABLE site, not "Immediate"', async () => {
            await render(pptx, VARIABLE_WAREHOUSE);

            const text = collectText(pptx.slides[0]);
            expect(text).toContain('2 months');
            expect(text).not.toContain('Immediate');
        });

        test('still shows the date for a FIXED site', async () => {
            await render(pptx, FIXED_WAREHOUSE);

            expect(collectText(pptx.slides[0])).toContain('15 Sep 2026');
        });
    });
});
