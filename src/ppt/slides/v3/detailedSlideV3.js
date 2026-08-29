const { LAYOUT, COLORS, FONT, FONT_SEMIBOLD, addSlideTitle } = require('./layoutV3');
const { addFooter, addTopRightLogo } = require('../v2/chromeV2');
const { propertyFields } = require('../propertyFields');

/**
 * An option's specification table.
 *
 * Carries the TCI field set — nineteen rows — which does not fit down one side of
 * a 16:9 slide at a readable size, so it runs as two columns beneath a full-width
 * project band. The photographs are on their own slide, so the whole page is
 * available for it.
 */

const LABEL_W = 2.05;
const VALUE_W = LAYOUT.COL_W - LABEL_W;
const BAND_H = 0.34;

// Row heights are estimated rather than measured: there is no metrics engine
// here, so a chars-per-inch heuristic decides how many lines a cell needs and we
// pass the result to pptxgenjs as explicit `rowH`. That keeps the rendered table
// height equal to the height computed here, instead of drifting from it.
const FONT_SIZE = 9;
const CHAR_W = 0.072;    // average glyph advance for Montserrat at 9pt
const LINE_H = 0.18;
const ROW_PAD = 0.12;
const MIN_ROW_H = 0.29;
const MAX_CELL_CHARS = 90;

// The natural height of nine rows leaves the lower third of a 16:9 slide empty,
// which reads as a table that ran out rather than one that fits. Rows are scaled
// up to fill the space, equally across both columns so the type rhythm matches,
// and capped so a short table does not turn into a ladder of huge cells.
const MAX_FILL_SCALE = 1.55;

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

const rowHeight = (row) => Math.max(
    Math.max(linesFor(row.label, LABEL_W), linesFor(clamp(row.value), VALUE_W)) * LINE_H + ROW_PAD,
    MIN_ROW_H,
);

/** One spec column, with each row's height scaled by `scale`. */
function addColumn(slide, rows, x, y, scale) {
    const labelOpts = {
        bold: true, color: COLORS.bg, fill: { color: COLORS.navy },
        fontFace: FONT_SEMIBOLD, fontSize: FONT_SIZE, valign: 'middle', margin: 0.05,
    };
    const valueOpts = {
        color: COLORS.navy, fill: { color: COLORS.sidebar },
        fontFace: FONT, fontSize: FONT_SIZE, valign: 'middle', margin: 0.05,
    };

    const cells = rows.map((row) => {
        const value = row.url
            ? {
                text: clamp(row.value),
                options: { ...valueOpts, hyperlink: { url: row.url }, color: COLORS.accentBlue, underline: { style: 'sng' } },
            }
            : { text: clamp(row.value ?? 'N/A'), options: valueOpts };
        return [{ text: row.label, options: labelOpts }, value];
    });

    const rowH = rows.map((row) => rowHeight(row) * scale);
    slide.addTable(cells, {
        x, y, w: LAYOUT.COL_W,
        colW: [LABEL_W, VALUE_W],
        rowH,
        border: { type: 'solid', pt: 0.5, color: COLORS.divider },
    });
    return rowH.reduce((sum, h) => sum + h, 0);
}

async function generateDetailedSlideV3(pptx, warehouse, selectedPhotoUrls, optionIndex, flags = {}) {
    const slide = pptx.addSlide();
    slide.background = { color: COLORS.bg };
    addSlideTitle(slide, `Option ${optionIndex} - ID ${warehouse.id}`);

    const rows = propertyFields(warehouse, flags);
    const header = rows.find((r) => r.kind === 'header');
    const subheader = rows.find((r) => r.kind === 'subheader');
    const fields = rows.filter((r) => r.kind === 'field');

    // Project band, full width — the property's name belongs across the page
    // rather than at the top of one of two columns.
    slide.addTable(
        [[
            {
                text: header.label,
                options: {
                    bold: true, color: COLORS.bg, fill: { color: COLORS.navy },
                    fontFace: FONT_SEMIBOLD, fontSize: 9, valign: 'middle', margin: 0.06,
                },
            },
            {
                text: clamp(header.value),
                options: {
                    bold: true, color: COLORS.navy, fill: { color: COLORS.sidebar },
                    fontFace: FONT_SEMIBOLD, fontSize: 9, valign: 'middle', margin: 0.06,
                },
            },
        ]],
        {
            x: LAYOUT.MARGIN, y: LAYOUT.CONTENT_TOP, w: LAYOUT.CONTENT_W,
            colW: [LABEL_W, LAYOUT.CONTENT_W - LABEL_W],
            rowH: [BAND_H],
            border: { type: 'solid', pt: 0.5, color: COLORS.divider },
        },
    );

    slide.addText(subheader.label, {
        x: LAYOUT.MARGIN - 0.1, y: LAYOUT.CONTENT_TOP + BAND_H + 0.04, w: 4.0, h: 0.26,
        fontFace: FONT, fontSize: 9, bold: true, color: COLORS.navy,
    });

    // Split so the longer column is on the left, which reads better when the two
    // end at different heights.
    const half = Math.ceil(fields.length / 2);
    const left = fields.slice(0, half);
    const right = fields.slice(half);

    const tablesY = LAYOUT.CONTENT_TOP + BAND_H + 0.34;
    const available = LAYOUT.CONTENT_BOTTOM - tablesY;
    const tallest = Math.max(
        left.reduce((sum, r) => sum + rowHeight(r), 0),
        right.reduce((sum, r) => sum + rowHeight(r), 0),
    );
    const scale = Math.min(Math.max(available / tallest, 1), MAX_FILL_SCALE);

    addColumn(slide, left, LAYOUT.MARGIN, tablesY, scale);
    addColumn(slide, right, LAYOUT.MARGIN + LAYOUT.COL_W + LAYOUT.GUTTER, tablesY, scale);

    addTopRightLogo(slide);
    addFooter(slide);
}

module.exports = { generateDetailedSlideV3 };
