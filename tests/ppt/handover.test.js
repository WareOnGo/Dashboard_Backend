const PptxGenJS = require('pptxgenjs');
const { formatHandover } = require('../../src/ppt/utils/handover');
const { generateIndexSlideV2 } = require('../../src/ppt/slides/v2/indexSlideV2');
const { generateIndexSlideGodamwale } = require('../../src/ppt/slides/godamwale/indexSlideGodamwale');
const { generateDetailedSlideV2 } = require('../../src/ppt/slides/v2/detailedSlideV2');
const { generateDetailedSlideGodamwale } = require('../../src/ppt/slides/godamwale/detailedSlideGodamwale');
const { generateDetailedSlideV3 } = require('../../src/ppt/slides/v3/detailedSlideV3');
const { generateDetailedSlideTci } = require('../../src/ppt/slides/tci/detailedSlideTci');
const { createPptBufferV2 } = require('../../src/ppt/services/pptServiceV2');
const { createPptBufferV3 } = require('../../src/ppt/services/pptServiceV3');
const { createPptBufferGodamwale } = require('../../src/ppt/services/pptServiceGodamwale');
const { createPptBufferTci } = require('../../src/ppt/services/pptServiceTci');
const { createPptBuffer } = require('../../src/ppt/services/pptService');
const { createDetailedPptBuffer } = require('../../src/ppt/services/detailedPptService');
const JSZip = require('jszip');

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
        }, NOW)).toBe('2 Months Post LOI');
    });

    test.each([
        [15, 'DAYS', '15 Days Post LOI'],
        [1, 'DAYS', '1 Day Post LOI'],
        [3, 'WEEKS', '3 Weeks Post LOI'],
        [1, 'WEEKS', '1 Week Post LOI'],
        [6, 'MONTHS', '6 Months Post LOI'],
        [1, 'MONTHS', '1 Month Post LOI'],
    ])('%s %s renders as "%s"', (value, unit, expected) => {
        expect(formatHandover({
            handoverType: 'VARIABLE', handoverLeadValue: value, handoverLeadUnit: unit,
        }, NOW)).toBe(expected);
    });

    /**
     * "Post LOI" states the reference point a lead time is counted from.
     *
     * A bare "1 Month" on a slide invites the client to count from the day they
     * received the deck; the site is actually available a month after the letter of
     * intent. So every lead time carries it — and NOTHING ELSE does, which is the
     * half worth asserting. A fixed handover is an absolute calendar date that no
     * LOI moves, and neither 'Immediate' nor 'Unconfirmed' is a duration counted
     * from anything, so appending it there would be wrong rather than merely noisy.
     */
    test('every variable lead time states its reference point', () => {
        for (const unit of ['DAYS', 'WEEKS', 'MONTHS']) {
            for (const value of [1, 2, 15]) {
                expect(formatHandover({
                    handoverType: 'VARIABLE', handoverLeadValue: value, handoverLeadUnit: unit,
                }, NOW)).toMatch(/ Post LOI$/);
            }
        }
    });

    test('nothing that is not a lead time claims to be post-LOI', () => {
        const notLeadTimes = [
            // A zero lead time, which is availability now by any reading.
            { handoverType: 'VARIABLE', handoverLeadValue: 0, handoverLeadUnit: 'MONTHS' },
            // Flagged variable but unusable, so the row cannot say when.
            { handoverType: 'VARIABLE', handoverLeadValue: null, handoverLeadUnit: 'MONTHS' },
            { handoverType: 'VARIABLE', handoverLeadValue: 3, handoverLeadUnit: 'FORTNIGHTS' },
            // An absolute date, which an LOI does not shift.
            { handoverType: 'FIXED', handoverDate: '2027-03-15' },
            { handoverType: 'FIXED', handoverDate: null },
            // The pre-migration date-only shape.
            '2027-06-01',
            null,
        ];
        for (const w of notLeadTimes) {
            expect(formatHandover(w, NOW)).not.toContain('Post LOI');
        }
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
        ['whitespace instead of a value', { handoverLeadValue: '   ', handoverLeadUnit: 'MONTHS' }],
        ['a boolean instead of a value', { handoverLeadValue: false, handoverLeadUnit: 'MONTHS' }],
        ['an array instead of a value', { handoverLeadValue: [], handoverLeadUnit: 'MONTHS' }],
        ['a fractional value', { handoverLeadValue: 1.5, handoverLeadUnit: 'MONTHS' }],
        ['a value outside the dashboard range', { handoverLeadValue: 121, handoverLeadUnit: 'MONTHS' }],
        ['a prototype property as a unit', { handoverLeadValue: 2, handoverLeadUnit: 'constructor' }],
        ['zero without a unit', { handoverLeadValue: 0, handoverLeadUnit: null }],
        ['an enum value this build does not know', { handoverLeadValue: 2, handoverLeadUnit: 'QUARTERS' }],
    ])('falls back to "Unconfirmed" given %s, even if availability is Yes', (_label, fields) => {
        expect(formatHandover({ handoverType: 'VARIABLE', availability: 'Yes', ...fields }, NOW)).toBe('Unconfirmed');
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
        }, NOW)).toBe('3 Months Post LOI');
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
        ['today', '2026-08-13T00:00:00Z', 'Immediate'],
        ['tomorrow', '2026-08-14T00:00:00Z', 'Immediate'],
        ['the last day inside the two-week window', '2026-08-27T00:00:00Z', 'Immediate'],
        ['the first day outside it', '2026-08-28T00:00:00Z', '28 Aug 2026'],
    ])('%s -> %s', (_label, iso, expected) => {
        expect(formatHandover({ handoverType: 'FIXED', handoverDate: new Date(iso) }, NOW)).toBe(expected);
    });

    test.each([null, undefined, '', ' '])(
        'a missing date (%s) is unconfirmed even with affirmative availability', (handoverDate) => {
            for (const handoverType of ['FIXED', null, undefined]) {
                expect(formatHandover({ handoverType, handoverDate, availability: 'Yes' }, NOW))
                    .toBe('Unconfirmed');
            }
        },
    );

    test.each(['Yes', ' yes ', 'YES', 'Immediate', ' IMMEDIATE ', 'Available'])(
        'availability %s cannot confirm handover without a recorded date', (availability) => {
            expect(formatHandover({ handoverType: null, handoverDate: null, availability }, NOW))
                .toBe('Unconfirmed');
            expect(formatHandover({ handoverType: 'FIXED', handoverDate: null, availability }, NOW))
                .toBe('Unconfirmed');
        },
    );

    test.each(['No', null, undefined, '', ' ', 'not available', 'Available on August', 'Immediate after LOI', true])(
        'does not infer immediate handover from availability %s', (availability) => {
            expect(formatHandover({ handoverType: 'FIXED', handoverDate: null, availability }, NOW))
                .toBe('Unconfirmed');
        },
    );

    test.each(['not a date', new Date(NaN), false, true, 0, [], '2026-02-30', '2025-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '0000-01-01', '2026-08-13T24:00:00Z', '2026-02-30T00:00:00.000Z'])(
        'an invalid date (%s) stays unconfirmed even with affirmative availability', (handoverDate) => {
            expect(formatHandover({ handoverType: 'FIXED', handoverDate, availability: 'Yes' }, NOW))
                .toBe('Unconfirmed');
        },
    );

    test.each(['Yes', 'Immediate', 'Available'])(
        'an explicit date or lead time takes precedence over availability %s', (availability) => {
            expect(formatHandover({ handoverType: 'FIXED', handoverDate: '2026-09-15', availability }, NOW))
                .toBe('15 Sep 2026');
            expect(formatHandover({ handoverType: 'VARIABLE', handoverLeadValue: 2, handoverLeadUnit: 'MONTHS', availability }, NOW))
                .toBe('2 Months Post LOI');
        },
    );

    test('inactive lead-time fields do not fill in a missing FIXED date', () => {
        const warehouse = {
            handoverType: 'FIXED', handoverDate: null,
            handoverLeadValue: 2, handoverLeadUnit: 'MONTHS',
        };
        expect(formatHandover(warehouse, NOW)).toBe('Unconfirmed');
        expect(formatHandover({ ...warehouse, availability: 'Yes' }, NOW)).toBe('Unconfirmed');
    });

    test('a pre-migration row with a null handoverType takes the date path', () => {
        expect(formatHandover({
            handoverType: null, handoverDate: new Date('2026-09-15T00:00:00Z'),
        }, NOW)).toBe('15 Sep 2026');
        expect(formatHandover({ handoverType: null, handoverDate: null }, NOW)).toBe('Unconfirmed');
    });

    test('an ISO string survives a serialization hop', () => {
        expect(formatHandover({ handoverType: 'FIXED', handoverDate: '2026-09-15' }, NOW)).toBe('15 Sep 2026');
    });

    test('accepts real leap days and serialized Prisma dates', () => {
        expect(formatHandover({ handoverType: 'FIXED', handoverDate: '2028-02-29' }, NOW)).toBe('29 Feb 2028');
        expect(formatHandover({ handoverType: 'FIXED', handoverDate: '2026-09-15T00:00:00.000Z' }, NOW)).toBe('15 Sep 2026');
    });

    test('does not infer a mode from stale lead fields or an unknown mode', () => {
        expect(formatHandover({ handoverType: null, handoverLeadValue: 2, handoverLeadUnit: 'MONTHS' }, NOW)).toBe('Unconfirmed');
        expect(formatHandover({ handoverType: 'IMMEDIATE', handoverDate: '2026-09-15' }, NOW)).toBe('Unconfirmed');
    });

    test('unparseable legacy free text leaves handover unconfirmed', () => {
        expect(formatHandover({ handoverType: null, handoverDate: 'ready now' }, NOW)).toBe('Unconfirmed');
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

describe('handover in alternate export paths', () => {
    beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] }));
    afterEach(() => jest.useRealTimers());

    test('standard with location enabled uses the same handover in index and details', async () => {
        const slides = await exportedTables(await createPptBuffer(
            [{ ...FIXED_WAREHOUSE, handoverDate: null }], {}, {}, true,
        ));
        const indexRows = slides.find(rows => rows[0]?.includes('Handover'));
        expect(indexRows[1][indexRows[0].indexOf('Handover')]).toBe('Unconfirmed');
        expect(slides.flat().find(row => row[0] === 'Handover')[1]).toBe('Unconfirmed');
    });

    test('TCI placeholders without explicit timing are unconfirmed', async () => {
        const slides = await exportedTables(await createPptBufferTci([]));
        expect(slides.flat().filter(row => row[0] === 'Handover timeline').map(row => row[1]))
            .toEqual(['Unconfirmed', 'Unconfirmed', 'Unconfirmed']);
    });

    test('Unconfirmed is specific to handover; missing rent retains its own wording', async () => {
        const slides = await exportedTables(await createPptBufferV3(
            [{ ...FIXED_WAREHOUSE, handoverDate: null, ratePerSqft: null }], {},
            { mapsLocation: false, pocSlide: false },
        ));
        expect(slides.flat().find(row => row[0] === 'Handover timeline')[1]).toBe('Unconfirmed');
        expect(slides.flat().find(row => row[0] === 'Rental per sq. ft.')[1]).toBe('On request');
    });
});

describe('formatHandover - argument tolerance', () => {
    test.each([null, undefined, {}, '', 'not a date', new Date(NaN)])(
        'an absent or unusable handover argument (%s) reads as unconfirmed', (warehouse) => {
            expect(formatHandover(warehouse, NOW)).toBe('Unconfirmed');
        },
    );

    test('the pre-migration date-only call shape still works', () => {
        // Guards a missed call site: passing a bare Date must not silently
        // resolve to 'Unconfirmed' via an undefined handoverType.
        expect(formatHandover(new Date('2026-09-15T00:00:00Z'), NOW)).toBe('15 Sep 2026');
        expect(formatHandover('2026-09-15', NOW)).toBe('15 Sep 2026');
    });

    test('defaults to the real clock when no reference date is given', () => {
        expect(formatHandover({ handoverType: 'FIXED', handoverDate: null })).toBe('Unconfirmed');
        expect(formatHandover({
            handoverType: 'VARIABLE', handoverLeadValue: 2, handoverLeadUnit: 'MONTHS',
        })).toBe('2 Months Post LOI');
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
    availability: 'Yes',
    handoverType: 'VARIABLE',
    handoverLeadValue: 2,
    handoverLeadUnit: 'MONTHS',
    handoverDate: null,
    WarehouseData: {},
    validPhotos: [],
};

// Render/export tests freeze the clock at NOW, so dates and boundary cases do
// not expire and expected strings stay independent of the formatter under test.
const FIXED_HANDOVER_DATE = new Date('2026-09-15T00:00:00Z');

const FIXED_WAREHOUSE = {
    ...VARIABLE_WAREHOUSE,
    id: 779,
    handoverType: 'FIXED',
    handoverLeadValue: null,
    handoverLeadUnit: null,
    handoverDate: FIXED_HANDOVER_DATE,
};

const FIXED_HANDOVER_LABEL = '15 Sep 2026';

describe('handover text reaches every deck that renders it', () => {
    let pptx;

    beforeEach(() => {
        jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
        pptx = new PptxGenJS();
        pptx.layout = 'LAYOUT_WIDE';
    });
    afterEach(() => jest.useRealTimers());

    describe.each([
        ['v2 index', (p, w) => generateIndexSlideV2(p, [w])],
        ['godamwale index', (p, w) => generateIndexSlideGodamwale(p, [w])],
        ['v2 detailed', (p, w) => generateDetailedSlideV2(p, w, [], 1)],
        ['godamwale detailed', (p, w) => generateDetailedSlideGodamwale(p, w, [], 1)],
        ['v3 detailed', (p, w) => generateDetailedSlideV3(p, w, [], 1)],
        ['tci detailed', (p, w) => generateDetailedSlideTci(p, w, [], 1)],
    ])('%s slide', (_name, render) => {
        test('shows the lead time for a VARIABLE site, not "Immediate"', async () => {
            await render(pptx, VARIABLE_WAREHOUSE);

            const text = collectText(pptx.slides[0]);
            expect(text).toContain('2 Months Post LOI');
            expect(text).not.toContain('Immediate');
        });

        test('still shows the date for a FIXED site', async () => {
            await render(pptx, FIXED_WAREHOUSE);

            expect(collectText(pptx.slides[0])).toContain(FIXED_HANDOVER_LABEL);
        });

        test('shows Unconfirmed when availability is Yes and no handover date is recorded', async () => {
            await render(pptx, { ...FIXED_WAREHOUSE, handoverDate: null });

            const text = collectText(pptx.slides[0]);
            expect(text).toContain('Unconfirmed');
        });
    });
});

// Inspect the handover cells themselves, including both index and details.
// A label elsewhere in a deck does not prove that these tables agree.
const xmlTableRows = (xml) => [...xml.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)]
    .map((row) => [...row[1].matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g)]
        .map((cell) => [...cell[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
            .map((text) => text[1]).join('')));

async function exportedTables(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    return Promise.all(zip.file(/^ppt\/slides\/slide\d+\.xml$/)
        .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
        .map(async (file) => xmlTableRows(await file.async('string'))));
}

describe.each([
    ['standard', createPptBuffer],
    ['v2', createPptBufferV2],
    ['v3', createPptBufferV3],
    ['godamwale', createPptBufferGodamwale],
    ['tci', createPptBufferTci],
    ['detailed', createDetailedPptBuffer],
])('%s exported handover tables', (variant, createBuffer) => {
    beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] }));
    afterEach(() => jest.useRealTimers());

    test.each([
        ['missing data and conflicting availability flags', [
            [VARIABLE_WAREHOUSE, '2 Months Post LOI'],
            [{ ...VARIABLE_WAREHOUSE, availability: 'No' }, '2 Months Post LOI'],
            [{ ...VARIABLE_WAREHOUSE, availability: null }, '2 Months Post LOI'],
            [FIXED_WAREHOUSE, FIXED_HANDOVER_LABEL],
            [{ ...FIXED_WAREHOUSE, handoverDate: null }, 'Unconfirmed'],
            [{ ...FIXED_WAREHOUSE, handoverType: null, handoverDate: null }, 'Unconfirmed'],
            [{ ...VARIABLE_WAREHOUSE, handoverLeadValue: null }, 'Unconfirmed'],
        ]],
        ['the new SOP applied to the October 15 export cases', [
            // 2984/2986: legacy Yes with all timing fields null.
            [{ ...FIXED_WAREHOUSE, handoverType: null, handoverDate: null }, 'Unconfirmed'],
            // 2990: FIXED with no date and a default lead unit left on the row.
            [{ ...FIXED_WAREHOUSE, handoverDate: null, handoverLeadUnit: 'MONTHS' }, 'Unconfirmed'],
            // 2983/3008 and 2204: affirmative legacy availability strings.
            [{ ...FIXED_WAREHOUSE, handoverType: null, handoverDate: null, availability: 'Immediate' }, 'Unconfirmed'],
            [{ ...FIXED_WAREHOUSE, handoverType: null, handoverDate: null, availability: 'Available' }, 'Unconfirmed'],
            [{ ...FIXED_WAREHOUSE, handoverDate: null, availability: ' yes ' }, 'Unconfirmed'],
            [{ ...FIXED_WAREHOUSE, handoverDate: null, availability: 'No' }, 'Unconfirmed'],
            [{ ...FIXED_WAREHOUSE, handoverDate: null, availability: null }, 'Unconfirmed'],
            [{ ...FIXED_WAREHOUSE, handoverDate: null, availability: 'Under construction/ Available on August' }, 'Unconfirmed'],
        ]],
        ['malformed timing and inactive fields', [
            [{ ...VARIABLE_WAREHOUSE, handoverLeadValue: ' ' }, 'Unconfirmed'],
            [{ ...VARIABLE_WAREHOUSE, handoverLeadUnit: null, handoverDate: '2026-01-01' }, 'Unconfirmed'],
            [{ ...FIXED_WAREHOUSE, handoverDate: null, handoverLeadValue: 2, handoverLeadUnit: 'MONTHS' }, 'Unconfirmed'],
            [{ ...FIXED_WAREHOUSE, handoverDate: '2026-02-30' }, 'Unconfirmed'],
            [{ ...VARIABLE_WAREHOUSE, handoverLeadValue: '120', handoverLeadUnit: 'DAYS' }, '120 Days Post LOI'],
        ]],
        ['dates, immediate boundaries and incomplete lead times', [
            [{ ...FIXED_WAREHOUSE, handoverDate: '2026-01-01' }, 'Immediate'],
            [{ ...FIXED_WAREHOUSE, handoverDate: '2026-08-27' }, 'Immediate'],
            [{ ...FIXED_WAREHOUSE, handoverDate: '2026-08-28' }, '28 Aug 2026'],
            [{ ...VARIABLE_WAREHOUSE, handoverLeadValue: 0 }, 'Immediate'],
            [{ ...VARIABLE_WAREHOUSE, handoverLeadValue: 1, handoverLeadUnit: 'DAYS' }, '1 Day Post LOI'],
            [{ ...FIXED_WAREHOUSE, handoverType: null }, FIXED_HANDOVER_LABEL],
            [{ ...FIXED_WAREHOUSE, handoverDate: 'not a date' }, 'Unconfirmed'],
            [{ ...VARIABLE_WAREHOUSE, handoverLeadUnit: null, handoverDate: FIXED_HANDOVER_DATE }, 'Unconfirmed'],
        ]],
    ])('exports consistent handover for %s', async (_label, cases) => {
        const warehouses = cases.map(([warehouse], index) => ({ ...warehouse, id: index + 1 }));
        const expected = cases.map(([, label]) => label);
        const buffer = await createBuffer(warehouses, {}, { mapsLocation: false, pocSlide: false });
        const slides = await exportedTables(buffer);
        const handoverValues = slides.flat()
            .filter((row) => row[0] === 'Handover timeline' || row[0] === 'Handover')
            .map((row) => row[1]);
        expect(handoverValues).toEqual(expected);

        if (!['tci', 'detailed'].includes(variant)) {
            const indexRows = slides.find((rows) => rows[0]?.includes('Handover'));
            expect(indexRows).toBeDefined();
            const availabilityColumn = indexRows[0].indexOf('Handover');
            expect(indexRows.slice(1).map((row) => row[availabilityColumn])).toEqual(handoverValues);
        }
    });

    test('keeps one handover reference date when generation crosses UTC midnight', async () => {
        jest.setSystemTime(new Date('2026-08-13T23:59:59Z'));
        const originalAddSlide = PptxGenJS.prototype.addSlide;
        const addSlide = jest.spyOn(PptxGenJS.prototype, 'addSlide').mockImplementation(function (...args) {
            // After the index (or TCI's first detail), the date crosses into the
            // next UTC day. A 15-day wait would now fall in the 14-day window.
            if (this.slides.length === 2) jest.setSystemTime(new Date('2026-08-14T00:00:01Z'));
            return originalAddSlide.apply(this, args);
        });
        const warehouses = [1, 2].map((id) => ({
            ...FIXED_WAREHOUSE, id, handoverDate: new Date('2026-08-28T00:00:00Z'),
        }));
        let buffer;
        try {
            buffer = await createBuffer(warehouses, {}, { mapsLocation: false, pocSlide: false });
        } finally {
            addSlide.mockRestore();
        }
        const slides = await exportedTables(buffer);
        expect(slides.flat()
            .filter((row) => row[0] === 'Handover timeline' || row[0] === 'Handover')
            .map((row) => row[1])).toEqual(['28 Aug 2026', '28 Aug 2026']);
        if (!['tci', 'detailed'].includes(variant)) {
            const indexRows = slides.find((rows) => rows[0]?.includes('Handover'));
            const availabilityColumn = indexRows[0].indexOf('Handover');
            expect(indexRows.slice(1).map((row) => row[availabilityColumn]))
                .toEqual(['28 Aug 2026', '28 Aug 2026']);
        }

        // A fresh export on the new day must recalculate rather than reusing the
        // previous deck's result or leaving cached handover values on the rows.
        const nextSlides = await exportedTables(await createBuffer(
            warehouses, {}, { mapsLocation: false, pocSlide: false },
        ));
        expect(nextSlides.flat()
            .filter((row) => row[0] === 'Handover timeline' || row[0] === 'Handover')
            .map((row) => row[1])).toEqual(['Immediate', 'Immediate']);
    });
});
