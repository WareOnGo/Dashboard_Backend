const {
    generateProsConsSlideV3, rowsPerSlide, propertyLabel, MIN_USABLE_ROW_H,
} = require('../../src/ppt/slides/v3/prosConsSlideV3');
const { LAYOUT } = require('../../src/ppt/slides/v3/layoutV3');

/**
 * The closing pros-and-cons table.
 *
 * It ships EMPTY on purpose — which trade-offs matter depends on the client's
 * requirement, so a human fills it in. That makes two things worth pinning: the
 * cells must stay genuinely empty (a placeholder left in by accident reads worse on
 * a client deck than a blank), and every row must stay tall enough to type into.
 */

/** Records what the slide builder asked for, without pulling in pptxgenjs. */
const fakePptx = () => {
    const slides = [];
    return {
        slides,
        addSlide() {
            const s = { titles: [], tables: [], images: [], texts: [] };
            slides.push(s);
            return {
                addText: (t, o) => { s.titles.push(typeof t === 'string' ? t : ''); s.texts.push({ t, o }); },
                addTable: (rows, opts) => s.tables.push({ rows, opts }),
                addImage: (o) => s.images.push(o),
                set background(v) { s.background = v; },
                get background() { return s.background; },
            };
        },
    };
};

const wh = (id) => ({ id });
const flatten = (cellText) => (Array.isArray(cellText)
    ? cellText.map((r) => r.text).join(' ')
    : String(cellText == null ? '' : cellText));

describe('generateProsConsSlideV3', () => {
    test('adds one row per property, under a header', () => {
        const pptx = fakePptx();
        const added = generateProsConsSlideV3(pptx, [wh(995), wh(1065), wh(2186)]);
        expect(added).toBe(1);
        const { rows } = pptx.slides[0].tables[0];
        expect(rows).toHaveLength(4);                    // header + 3
        expect(rows[0].map((c) => c.text)).toEqual(['Property', 'Pros', 'Cons']);
    });

    test('the pros and cons cells are empty, not placeholders', () => {
        // A "—" or "To be completed" would have to be deleted from every cell before
        // anyone could type, and one left behind ships to a client.
        const pptx = fakePptx();
        generateProsConsSlideV3(pptx, [wh(1), wh(2)]);
        const body = pptx.slides[0].tables[0].rows.slice(1);
        for (const row of body) {
            expect(row[1].text).toBe('');
            expect(row[2].text).toBe('');
        }
    });

    test('each row names the option and the warehouse id', () => {
        // Matching the wording on that property's own detail slide, so a reader can
        // connect a row back to the pages it summarises.
        const pptx = fakePptx();
        generateProsConsSlideV3(pptx, [wh(995), wh(2186)]);
        const body = pptx.slides[0].tables[0].rows.slice(1);
        expect(flatten(body[0][0].text)).toBe('Option 1 ID 995');
        expect(flatten(body[1][0].text)).toBe('Option 2 ID 2186');
    });

    test('rows share the full content height', () => {
        const pptx = fakePptx();
        generateProsConsSlideV3(pptx, [wh(1), wh(2), wh(3)]);
        const { opts } = pptx.slides[0].tables[0];
        const total = opts.rowH.reduce((a, b) => a + b, 0);
        expect(total).toBeCloseTo(LAYOUT.CONTENT_H, 5);
    });

    test('the two comment columns split the width evenly', () => {
        const pptx = fakePptx();
        generateProsConsSlideV3(pptx, [wh(1)]);
        const { opts } = pptx.slides[0].tables[0];
        expect(opts.colW[1]).toBeCloseTo(opts.colW[2], 5);
        expect(opts.colW.reduce((a, b) => a + b, 0)).toBeCloseTo(LAYOUT.CONTENT_W, 5);
    });

    /**
     * A long deck must not compress rows into slivers. Twenty properties sharing one
     * slide would give each 0.22in — less than the height of the text someone has to
     * type into it — so the table continues on another slide instead.
     */
    test('paginates rather than shrinking rows below a usable height', () => {
        const perSlide = rowsPerSlide();
        const pptx = fakePptx();
        const many = Array.from({ length: perSlide + 1 }, (_, i) => wh(i + 1));
        expect(generateProsConsSlideV3(pptx, many)).toBe(2);
        for (const s of pptx.slides) {
            const bodyHeights = s.tables[0].opts.rowH.slice(1);
            bodyHeights.forEach((h) => expect(h).toBeGreaterThanOrEqual(MIN_USABLE_ROW_H));
        }
    });

    test('option numbers keep counting across a page break', () => {
        // Option 13 on the second slide, not Option 1 again — the numbers have to
        // match the detail slides they refer to.
        const perSlide = rowsPerSlide();
        const pptx = fakePptx();
        generateProsConsSlideV3(pptx, Array.from({ length: perSlide + 2 }, (_, i) => wh(i + 1)));
        const second = pptx.slides[1].tables[0].rows.slice(1);
        expect(flatten(second[0][0].text)).toBe(`Option ${perSlide + 1} ID ${perSlide + 1}`);
    });

    test('a split deck says which page of the table you are on', () => {
        const pptx = fakePptx();
        generateProsConsSlideV3(pptx, Array.from({ length: rowsPerSlide() + 1 }, (_, i) => wh(i + 1)));
        expect(pptx.slides[0].titles[0]).toBe('Pros & Cons (1 of 2)');
        expect(pptx.slides[1].titles[0]).toBe('Pros & Cons (2 of 2)');
    });

    test('a single-page table is titled plainly', () => {
        const pptx = fakePptx();
        generateProsConsSlideV3(pptx, [wh(1)]);
        expect(pptx.slides[0].titles[0]).toBe('Pros & Cons');
    });

    test('no properties means no slide at all', () => {
        for (const input of [[], null, undefined, [null, undefined]]) {
            const pptx = fakePptx();
            expect(generateProsConsSlideV3(pptx, input)).toBe(0);
            expect(pptx.slides).toHaveLength(0);
        }
    });

    test('a property with no id still gets a row', () => {
        // The row is the point; a missing id degrades to just the option number
        // rather than rendering "ID undefined".
        const pptx = fakePptx();
        generateProsConsSlideV3(pptx, [{}]);
        expect(flatten(pptx.slides[0].tables[0].rows[1][0].text)).toBe('Option 1 ');
        expect(flatten(pptx.slides[0].tables[0].rows[1][0].text)).not.toContain('undefined');
    });
});

describe('propertyLabel', () => {
    test('puts the id in a lighter aside under the option number', () => {
        const [main, aside] = propertyLabel(wh(2186), 3);
        expect(main.text).toBe('Option 3');
        expect(main.options.breakLine).toBe(true);
        expect(aside.text).toBe('ID 2186');
        expect(aside.options.bold).toBe(false);
    });
});
