const { LAYOUT, COLORS, FONT, FONT_SEMIBOLD, addSlideTitle } = require('./layoutV3');
const { addFooter, addTopRightLogo } = require('../v2/chromeV2');
const { fetchImage } = require('../../utils/image');
const { logWarn } = require('../../utils/logger');
const { propertyFields } = require('../propertyFields');

/**
 * An option's specification table.
 *
 * One continuous column of label/value rows spanning the slide, exactly as the
 * TCI details slide reads — only in WareOnGo's palette and typeface. An earlier
 * pass split the rows into two side-by-side tables to use the width of a 16:9
 * slide; reading a spec sheet across two columns means hunting for where the
 * list resumes, so it is one list again and the width goes to the values.
 *
 * The photographs are on their own slide, so the whole page is available.
 */

const LABEL_W = 2.60;              // as TCI's, and wide enough for the longest label

/**
 * A thin photograph down the right edge.
 *
 * The value column was enormously over-provisioned: measured across 2,040 cells
 * from 120 warehouses, the median value is 10 characters and the LONGEST is 64,
 * against a column that fits 102 on a line. So most of the right-hand side was
 * white space, which read as a table that had run out of things to say.
 *
 * 1.2in is safe rather than chosen by eye. At this width the value column still
 * fits 81 characters per line, so nothing in that measured set wraps — which
 * matters because a wrapped value grows its row, and a taller table pushes the
 * fill scale down and squeezes every OTHER row on the slide. The strip buys
 * nothing if it costs that.
 */
const STRIP_W = 1.20;
const STRIP_GAP = 0.16;
/** Width the values get back when there is no photograph to show. */
const VALUE_W_FULL = LAYOUT.CONTENT_W - LABEL_W;
const VALUE_W_WITH_STRIP = VALUE_W_FULL - STRIP_W - STRIP_GAP;

// Row heights are estimated rather than measured: there is no metrics engine
// here, so a chars-per-inch heuristic decides how many lines a cell needs and the
// result is passed to pptxgenjs as explicit `rowH`. That keeps the rendered table
// height equal to the height computed here instead of drifting from it.
const FONT_SIZE = 8;
const CHAR_W = 0.064;    // average glyph advance for Montserrat at 8pt
const LINE_H = 0.155;
const ROW_PAD = 0.08;
const MIN_ROW_H = 0.235;
// The value column fits about 102 characters on one line at this size, so the
// clamp sits just under that: truncating earlier would drop text the slide had
// room for, and later would wrap a row the height budget assumes is single-line.
const MAX_CELL_CHARS = 100;

// Nineteen rows at their natural height leave a band of empty page at the
// bottom, which reads as a table that ran out rather than one that fits. Rows
// scale to fill the content box, capped so a deck with fewer rows does not turn
// into a ladder of huge cells.
const MAX_FILL_SCALE = 1.4;
// ...and a floor, so a value that does wrap despite the clamp pulls the table
// back into the page instead of running under the footer. 0.85 still leaves room
// for an 8pt line, so nothing is clipped.
const MIN_FILL_SCALE = 0.85;

const clamp = (text) => {
    if (text == null) return '';
    const s = String(text);
    return s.length <= MAX_CELL_CHARS ? s : `${s.slice(0, MAX_CELL_CHARS - 1).trimEnd()}…`;
};

const linesFor = (text, colW) => {
    if (!text) return 1;
    const usable = Math.max(colW - 0.12, 0.1);
    const perLine = Math.max(Math.floor(usable / CHAR_W), 1);
    return Math.max(Math.ceil(String(text).length / perLine), 1);
};

const rowHeight = (row, valueW) => {
    // The subheader spans both columns, so only its own text can wrap it.
    const lines = row.kind === 'subheader'
        ? linesFor(row.label, LABEL_W + valueW)
        : Math.max(linesFor(row.label, LABEL_W), linesFor(clamp(row.value), valueW));
    return Math.max(lines * LINE_H + ROW_PAD, MIN_ROW_H);
};

/**
 * Which photograph goes in the strip, chosen from the ones already in the deck.
 *
 * Deterministic on the warehouse id rather than actually random. The point of
 * varying it is that ten properties should not all show the same framing — not
 * that it should differ between two generations of the same deck. A client asking
 * for the deck again should get the deck they were sent, so this is a hash, not
 * Math.random().
 */
function pickStripPhoto(warehouseId, photos) {
    if (!photos || !photos.length) return null;
    const id = Number(warehouseId);
    const seed = Number.isFinite(id) ? Math.abs(Math.trunc(id)) : 0;
    return photos[seed % photos.length];
}

/**
 * @param {object} pptx
 * @param {object} warehouse
 * @param {string[]} selectedPhotoUrls - photographs, for the strip. Empty or
 *   unclassified means no strip and the values take the full width.
 * @param {number} optionIndex
 * @param {object} [flags]
 * @param {boolean} [photosAreClassified] - whether selectedPhotoUrls is known to
 *   hold photographs only. False for the legacy flat-array payload, where
 *   documents and photographs arrive in one list and cannot be told apart here —
 *   see the note at the strip below.
 */
async function generateDetailedSlideV3(
    pptx, warehouse, selectedPhotoUrls, optionIndex, flags = {}, photosAreClassified = false,
) {
    const slide = pptx.addSlide();
    slide.background = { color: COLORS.bg };
    addSlideTitle(slide, `Option ${optionIndex} - ID ${warehouse.id}`);

    // A STRIP ONLY WHEN WE KNOW THE IMAGE IS A PHOTOGRAPH.
    //
    // The v3 payload separates photographs from layout drawings, so `photos` there
    // is exactly what we want. The legacy flat array does not: documents arrive in
    // the same list, and nothing available at this layer can tell a shed from a
    // khata extract. Cropping a land record into a 1.2in ribbon down a client deck
    // is worse than leaving the space empty, so that path renders no strip and the
    // values take back the full width.
    let stripImage = null;
    const stripUrl = photosAreClassified
        ? pickStripPhoto(warehouse && warehouse.id, selectedPhotoUrls)
        : null;
    if (stripUrl) {
        try {
            stripImage = await fetchImage(stripUrl);
        } catch (err) {
            logWarn('detailedSlideV3', 'generateDetailedSlideV3', 'Strip photograph failed to load',
                { warehouseId: warehouse && warehouse.id, error: err && err.message });
        }
    }
    const hasStrip = !!(stripImage && stripImage.data);
    const valueW = hasStrip ? VALUE_W_WITH_STRIP : VALUE_W_FULL;

    // The project-name band is dropped here but kept in the TCI deck, which is
    // why propertyFields still returns it: the slide title already identifies the
    // property, and the address is on the index slide against the same option.
    const rows = propertyFields(warehouse, flags).filter((row) => row.kind !== 'header');

    const subHeaderOpts = {
        bold: true, color: COLORS.navy, fill: { color: COLORS.bg },
        fontFace: FONT_SEMIBOLD, fontSize: 8.5, valign: 'middle', margin: 0.06,
    };
    const labelOpts = {
        bold: true, color: COLORS.bg, fill: { color: COLORS.navy },
        fontFace: FONT_SEMIBOLD, fontSize: FONT_SIZE, valign: 'middle', margin: 0.05,
    };
    const valueOpts = {
        color: COLORS.navy, fill: { color: COLORS.sidebar },
        fontFace: FONT, fontSize: FONT_SIZE, valign: 'middle', margin: 0.05,
    };

    const cells = rows.map((row) => {
        if (row.kind === 'subheader') {
            return [{ text: row.label, options: { ...subHeaderOpts, colspan: 2 } }];
        }
        const value = row.url
            ? {
                text: clamp(row.value),
                options: { ...valueOpts, hyperlink: { url: row.url }, color: COLORS.accentBlue, underline: { style: 'sng' } },
            }
            : { text: clamp(row.value ?? 'N/A'), options: valueOpts };
        return [{ text: row.label, options: labelOpts }, value];
    });

    const natural = rows.map((row) => rowHeight(row, valueW));
    const total = natural.reduce((sum, h) => sum + h, 0);
    const scale = Math.min(Math.max(LAYOUT.CONTENT_H / total, MIN_FILL_SCALE), MAX_FILL_SCALE);

    slide.addTable(cells, {
        x: LAYOUT.MARGIN, y: LAYOUT.CONTENT_TOP, w: LABEL_W + valueW,
        colW: [LABEL_W, valueW],
        rowH: natural.map((h) => h * scale),
        border: { type: 'solid', pt: 0.5, color: COLORS.divider },
    });

    if (hasStrip) {
        // Matched to the TABLE's height, not the content box's. The fill scale is
        // capped, so a short table stops before the bottom of the page; a strip run
        // to CONTENT_H would then overhang it and read as two unrelated objects
        // rather than one layout.
        const tableH = Math.min(total * scale, LAYOUT.CONTENT_H);
        const dims = stripImage.dims;
        const box = {
            x: LAYOUT.MARGIN + LABEL_W + valueW + STRIP_GAP,
            y: LAYOUT.CONTENT_TOP,
            w: STRIP_W,
            h: tableH,
        };
        if (dims && dims.w > 0 && dims.h > 0) {
            // pptxgenjs reads the source aspect from the top-level w/h when
            // cropping, so those carry the real ratio while `sizing` pins the box.
            // A landscape photograph loses most of its width here, which is the
            // point: a centre slice of a shed still reads as a shed.
            slide.addImage({
                data: stripImage.data,
                x: box.x, y: box.y, w: 10, h: 10 / (dims.w / dims.h),
                sizing: { type: 'cover', w: box.w, h: box.h, x: 0, y: 0 },
            });
        } else {
            slide.addImage({ data: stripImage.data, ...box, sizing: { type: 'cover', w: box.w, h: box.h } });
        }
    }

    addTopRightLogo(slide);
    addFooter(slide);
}

module.exports = {
    generateDetailedSlideV3, pickStripPhoto, STRIP_W, STRIP_GAP,
    VALUE_W_FULL, VALUE_W_WITH_STRIP,
};
