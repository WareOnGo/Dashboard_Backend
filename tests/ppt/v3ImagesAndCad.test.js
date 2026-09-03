const {
    chunkSizes, gridBoxes, isImageUrl, MAX_PER_SLIDE,
} = require('../../src/ppt/slides/v3/photosSlideV3');
const { placeDrawing, isCadUrl, REGION } = require('../../src/ppt/slides/v3/cadSlideV3');

/**
 * v3's photographs and layout drawings.
 *
 * Photographs used to be capped at four because there were only four grids. They
 * now paginate, and drawings — which cannot survive the treatment a photograph
 * shrugs off — get a slide each.
 */

describe('photograph pagination', () => {
    test('splits into balanced slides rather than filling the first', () => {
        // 6+2 leaves two photographs adrift on a slide of their own, which reads as
        // a mistake. The grid is centred either way, so packing buys nothing.
        expect(chunkSizes(8)).toEqual([4, 4]);
        expect(chunkSizes(7)).toEqual([4, 3]);
        expect(chunkSizes(13)).toEqual([5, 4, 4]);
        expect(chunkSizes(20)).toEqual([5, 5, 5, 5]);
    });

    test('anything up to the per-slide maximum stays on one slide', () => {
        for (let n = 1; n <= MAX_PER_SLIDE; n += 1) {
            expect(chunkSizes(n)).toEqual([n]);
        }
    });

    test('never puts more than the maximum on a slide, and never loses one', () => {
        for (let n = 1; n <= 40; n += 1) {
            const sizes = chunkSizes(n);
            expect(sizes.reduce((a, b) => a + b, 0)).toBe(n);
            sizes.forEach((size) => expect(size).toBeLessThanOrEqual(MAX_PER_SLIDE));
        }
    });

    test('no photographs means no slides', () => {
        expect(chunkSizes(0)).toEqual([]);
        expect(chunkSizes(-1)).toEqual([]);
    });

    test('a six-up grid still fits the content box', () => {
        // Six is the ceiling because seven needs a third row and each photograph
        // ends up smaller than a thumbnail.
        const boxes = gridBoxes([3, 3]);
        expect(boxes).toHaveLength(6);
        const bottom = Math.max(...boxes.map((b) => b.y + b.h));
        const right = Math.max(...boxes.map((b) => b.x + b.w));
        expect(bottom).toBeLessThanOrEqual(REGION.y + REGION.h + 0.001);
        expect(right).toBeLessThanOrEqual(REGION.x + REGION.w + 0.001);
    });

    test('accepts the image extensions a listing actually carries', () => {
        expect(isImageUrl('https://x/a.JPG')).toBe(true);
        expect(isImageUrl('https://x/a.webp?token=1')).toBe(true);
        expect(isImageUrl('https://x/a.pdf')).toBe(false);
        expect(isImageUrl(null)).toBe(false);
    });
});

describe('layout drawing placement', () => {
    const fits = (box) => {
        // A turned drawing's footprint is its box with the sides swapped, since
        // pptxgenjs rotates about the centre.
        const w = box.rotate ? box.h : box.w;
        const h = box.rotate ? box.w : box.h;
        return w <= REGION.w + 0.001 && h <= REGION.h + 0.001;
    };

    test('turns a portrait drawing, because that makes it bigger', () => {
        // A4 portrait: 3.18in wide upright, 6.36in turned. The text ends up
        // sideways, which is the accepted trade — a legible sideways dimension
        // beats an upright one nobody can read off a projector.
        const box = placeDrawing(2100, 2970);
        expect(box.rotate).toBe(90);
        expect(box.scaleGain).toBeCloseTo(1.414, 2);
        expect(fits(box)).toBe(true);
    });

    test('leaves a landscape drawing alone', () => {
        for (const [w, h] of [[4200, 2970], [2000, 1500], [6000, 1200], [2000, 2000]]) {
            const box = placeDrawing(w, h);
            expect(box.rotate).toBe(0);
            expect(fits(box)).toBe(true);
        }
    });

    test('never crops: the whole drawing is always on the slide', () => {
        // The point of the slide. A photograph survives cover-cropping; a plan
        // loses a dimension string, a legend, or a bay.
        for (const [w, h] of [[2100, 2970], [4200, 2970], [1000, 4000], [6000, 1200], [800, 600]]) {
            const box = placeDrawing(w, h);
            const aspect = w / h;
            expect(box.w / box.h).toBeCloseTo(aspect, 4);
            expect(fits(box)).toBe(true);
        }
    });

    test('centres the drawing in the content region', () => {
        const box = placeDrawing(4200, 2970);
        expect(box.x + box.w / 2).toBeCloseTo(REGION.x + REGION.w / 2, 4);
        expect(box.y + box.h / 2).toBeCloseTo(REGION.y + REGION.h / 2, 4);
    });

    test('a very tall drawing gains the most from turning', () => {
        const box = placeDrawing(1000, 4000);
        expect(box.rotate).toBe(90);
        expect(box.scaleGain).toBeGreaterThan(2);
        expect(fits(box)).toBe(true);
    });

    test('accepts svg, which a plan is often exported as', () => {
        expect(isCadUrl('https://x/plan.svg')).toBe(true);
        expect(isCadUrl('https://x/plan.dwg')).toBe(false);
    });
});

const { splitSelection } = require('../../src/ppt/services/pptServiceV3');

/**
 * How a warehouse's selection is read.
 *
 * v2, godamwale and the detailed deck all still send a flat array, so both shapes
 * have to work. If the array form ever stopped being understood, three decks would
 * silently render with no photographs at all.
 */
describe('splitSelection', () => {
    test('a flat array is all photographs, as every other deck sends', () => {
        expect(splitSelection(['a.jpg', 'b.jpg']))
            .toEqual({ photos: ['a.jpg', 'b.jpg'], cad: [], classified: false });
    });

    test('the v3 shape separates drawings from photographs', () => {
        expect(splitSelection({ photos: ['a.jpg'], cad: ['plan.png'] }))
            .toEqual({ photos: ['a.jpg'], cad: ['plan.png'], classified: true });
    });

    test('either half may be absent', () => {
        expect(splitSelection({ cad: ['plan.png'] }))
            .toEqual({ photos: [], cad: ['plan.png'], classified: true });
        expect(splitSelection({ photos: ['a.jpg'] }))
            .toEqual({ photos: ['a.jpg'], cad: [], classified: true });
    });

    test('nothing selected yields two empty lists, never undefined', () => {
        // The caller spreads the result straight into two slide builders; a missing
        // key there would throw rather than skip.
        for (const input of [undefined, null, {}, 'nonsense', 42]) {
            expect(splitSelection(input).photos).toEqual([]);
            expect(splitSelection(input).cad).toEqual([]);
        }
    });

    test('a non-array in either field is ignored rather than trusted', () => {
        const r = splitSelection({ photos: 'a.jpg', cad: { 0: 'b.png' } });
        expect(r.photos).toEqual([]);
        expect(r.cad).toEqual([]);
    });

    /**
     * `classified` gates the detail slide's photograph strip.
     *
     * Only the object shape guarantees `photos` holds photographs. In the flat
     * array a khata extract and a shed arrive in one list, and cropping a land
     * record into a 1.2in ribbon down a client deck is worse than leaving the
     * space empty — so that path gets no strip at all.
     */
    test('only the object shape claims its photographs are classified', () => {
        expect(splitSelection({ photos: ['a.jpg'], cad: [] }).classified).toBe(true);
        expect(splitSelection(['a.jpg']).classified).toBe(false);
        expect(splitSelection(undefined).classified).toBe(false);
    });
});

const {
    pickStripPhoto, VALUE_W_FULL, VALUE_W_WITH_STRIP, STRIP_W,
} = require('../../src/ppt/slides/v3/detailedSlideV3');

/**
 * The detail slide's photograph strip.
 *
 * The value column was over-provisioned: measured across 2,040 cells from 120
 * warehouses the median value is 10 characters and the longest 64, against a
 * column fitting 102. The strip spends that white space — but must not cost the
 * table anything, because a wrapped value grows its row and a taller table
 * squeezes every other row through the fill scale.
 */
describe('detail slide photograph strip', () => {
    const CHAR_W = 0.064;
    const charsPerLine = (w) => Math.floor((w - 0.12) / CHAR_W);
    /** The longest value seen in the measured set. */
    const LONGEST_MEASURED_VALUE = 64;

    test('the narrowed value column still fits the longest real value on one line', () => {
        // The whole justification for 1.2in. If this fails, the strip has started
        // costing row height and should be narrowed or dropped.
        expect(charsPerLine(VALUE_W_WITH_STRIP)).toBeGreaterThan(LONGEST_MEASURED_VALUE);
    });

    test('the strip and gap account for exactly what the values gave up', () => {
        expect(VALUE_W_FULL - VALUE_W_WITH_STRIP).toBeCloseTo(STRIP_W + 0.16, 5);
    });

    test('picks a photograph deterministically, not randomly', () => {
        // A client asking for the deck again should get the deck they were sent.
        const photos = ['a.jpg', 'b.jpg', 'c.jpg'];
        expect(pickStripPhoto(918, photos)).toBe(pickStripPhoto(918, photos));
    });

    test('different properties do not all show the same framing', () => {
        const photos = ['a.jpg', 'b.jpg', 'c.jpg'];
        const picked = new Set([1, 2, 3, 4, 5, 6].map((id) => pickStripPhoto(id, photos)));
        expect(picked.size).toBeGreaterThan(1);
    });

    test('always picks something that is actually in the list', () => {
        const photos = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'];
        for (const id of [0, 1, 917, 918, 2016, 99999]) {
            expect(photos).toContain(pickStripPhoto(id, photos));
        }
    });

    test('no photographs means no strip, and no crash', () => {
        expect(pickStripPhoto(918, [])).toBeNull();
        expect(pickStripPhoto(918, null)).toBeNull();
        expect(pickStripPhoto(undefined, ['a.jpg'])).toBe('a.jpg');
    });
});
