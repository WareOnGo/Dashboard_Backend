const { LAYOUT, COLORS, FONT, FONT_SEMIBOLD, addSlideTitle } = require('./layoutV3');
const { addFooter, addTopRightLogo } = require('../v2/chromeV2');

/**
 * A pros-and-cons table, one row per property, left EMPTY for a human to fill in.
 *
 * This is the deck's closing argument and the one slide we cannot generate: which
 * trade-offs matter depends on the client's requirement, which lives in the head of
 * whoever is presenting. So the slide ships as a structured blank — the properties
 * enumerated in the deck's own order, with room to type beside each.
 *
 * The cells are GENUINELY EMPTY rather than seeded with a placeholder. A "—" or
 * "To be completed" would have to be deleted from every cell before typing, and a
 * placeholder left in by accident reads worse on a client deck than a blank does.
 *
 * WHY A GRID HERE, when the connectivity slide deliberately has none. There the
 * rules were decoration around numbers that already aligned. Here the cell
 * boundaries are the only thing showing where one property's notes end and the
 * next begin — on an empty table, remove them and there is nothing on the slide at
 * all. The vertical rule between Pros and Cons is doing the same job: it is the
 * "split" in a split table.
 */

/** Enough vertical room to type two lines at body size. Below this a row is useless. */
const MIN_USABLE_ROW_H = 0.34;
const HEADER_H = 0.28;
/** The property column: wide enough for "Option 10" over "ID 2186". */
const LABEL_W = 1.25;

/**
 * How many properties fit on one slide while leaving each row usable.
 *
 * A deck of twenty properties would otherwise give each 0.22in — narrower than the
 * text it has to hold, so the table would render as unfillable slivers. Past the
 * limit the table continues on another slide instead, which is the only option that
 * keeps every row typeable.
 */
function rowsPerSlide(contentH = LAYOUT.CONTENT_H) {
    return Math.max(1, Math.floor((contentH - HEADER_H) / MIN_USABLE_ROW_H));
}

/**
 * Label for one property, matching the "Option 3 - ID 2186" wording its own detail
 * slide carries, so a reader can connect a row back to the pages it summarises.
 *
 * @param {object} warehouse
 * @param {number} optionNumber
 */
function propertyLabel(warehouse, optionNumber) {
    const id = warehouse && warehouse.id;
    return [
        { text: `Option ${optionNumber}`, options: { breakLine: true } },
        {
            text: id ? `ID ${id}` : '',
            options: {
                fontFace: FONT, fontSize: 6.5, bold: false, color: COLORS.navyMuted,
            },
        },
    ];
}

/**
 * @param {object} pptx
 * @param {Array<object>} warehouses - in deck order; option numbers follow the index
 * @returns {number} how many slides were added
 */
function generateProsConsSlideV3(pptx, warehouses) {
    const list = Array.isArray(warehouses) ? warehouses.filter(Boolean) : [];
    if (!list.length) return 0;

    const perSlide = rowsPerSlide();
    const chunks = [];
    for (let i = 0; i < list.length; i += perSlide) {
        chunks.push(list.slice(i, i + perSlide));
    }

    const rule = { type: 'solid', pt: 0.5, color: COLORS.divider };
    const noRule = { type: 'none' };
    /** [top, right, bottom, left] — a light box around every cell. */
    const cell = [rule, rule, rule, rule];

    const head = (text) => ({
        text,
        options: {
            bold: true, color: COLORS.bg, fill: { color: COLORS.navy },
            fontFace: FONT_SEMIBOLD, fontSize: 7.5, valign: 'middle', margin: 0.06,
            align: 'left', border: [noRule, noRule, noRule, noRule],
        },
    });

    chunks.forEach((chunk, chunkIndex) => {
        const slide = pptx.addSlide();
        slide.background = { color: COLORS.bg };
        addSlideTitle(slide, chunks.length > 1
            ? `Pros & Cons (${chunkIndex + 1} of ${chunks.length})`
            : 'Pros & Cons');

        const table = [[head('Property'), head('Pros'), head('Cons')]];
        chunk.forEach((w, i) => {
            const optionNumber = chunkIndex * perSlide + i + 1;
            table.push([
                {
                    text: propertyLabel(w, optionNumber),
                    options: {
                        color: COLORS.navy, fontFace: FONT_SEMIBOLD, fontSize: 8,
                        valign: 'middle', align: 'left', margin: 0.06, border: cell,
                    },
                },
                // Empty, and top-aligned so typed text starts at the top of the box
                // rather than floating in the middle of a tall row.
                {
                    text: '',
                    options: {
                        color: COLORS.navy, fontFace: FONT, fontSize: 8,
                        valign: 'top', align: 'left', margin: 0.08, border: cell,
                    },
                },
                {
                    text: '',
                    options: {
                        color: COLORS.navy, fontFace: FONT, fontSize: 8,
                        valign: 'top', align: 'left', margin: 0.08, border: cell,
                    },
                },
            ]);
        });

        // Rows share the full content height, so the table fills the slide instead
        // of leaving dead space under a short list.
        const bodyH = (LAYOUT.CONTENT_H - HEADER_H) / chunk.length;
        const splitW = (LAYOUT.CONTENT_W - LABEL_W) / 2;

        slide.addTable(table, {
            x: LAYOUT.MARGIN, y: LAYOUT.CONTENT_TOP, w: LAYOUT.CONTENT_W,
            colW: [LABEL_W, splitW, splitW],
            rowH: [HEADER_H, ...Array(chunk.length).fill(bodyH)],
            fill: { color: COLORS.sidebar },
        });

        addTopRightLogo(slide);
        addFooter(slide);
    });

    return chunks.length;
}

module.exports = { generateProsConsSlideV3, rowsPerSlide, propertyLabel, MIN_USABLE_ROW_H };
