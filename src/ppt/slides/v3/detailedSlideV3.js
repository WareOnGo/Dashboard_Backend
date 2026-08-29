const { LAYOUT, COLORS, FONT, FONT_SEMIBOLD, addSlideTitle } = require('./layoutV3');
const { addFooter, addTopRightLogo } = require('../v2/chromeV2');
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
const VALUE_W = LAYOUT.CONTENT_W - LABEL_W;

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

const rowHeight = (row) => {
    // The subheader spans both columns, so only its own text can wrap it.
    const lines = row.kind === 'subheader'
        ? linesFor(row.label, LAYOUT.CONTENT_W)
        : Math.max(linesFor(row.label, LABEL_W), linesFor(clamp(row.value), VALUE_W));
    return Math.max(lines * LINE_H + ROW_PAD, MIN_ROW_H);
};

async function generateDetailedSlideV3(pptx, warehouse, selectedPhotoUrls, optionIndex, flags = {}) {
    const slide = pptx.addSlide();
    slide.background = { color: COLORS.bg };
    addSlideTitle(slide, `Option ${optionIndex} - ID ${warehouse.id}`);

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

    const natural = rows.map(rowHeight);
    const total = natural.reduce((sum, h) => sum + h, 0);
    const scale = Math.min(Math.max(LAYOUT.CONTENT_H / total, MIN_FILL_SCALE), MAX_FILL_SCALE);

    slide.addTable(cells, {
        x: LAYOUT.MARGIN, y: LAYOUT.CONTENT_TOP, w: LAYOUT.CONTENT_W,
        colW: [LABEL_W, VALUE_W],
        rowH: natural.map((h) => h * scale),
        border: { type: 'solid', pt: 0.5, color: COLORS.divider },
    });

    addTopRightLogo(slide);
    addFooter(slide);
}

module.exports = { generateDetailedSlideV3 };
