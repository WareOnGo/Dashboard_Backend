const { COLORS, FONT } = require('../v2/themeV2');

/**
 * v3 shares v2's palette, typeface and chrome wholesale — it is the same
 * WareOnGo deck, so the branding is imported rather than copied. What differs is
 * the page: v2 puts a narrow spec sidebar beside the photographs, whereas v3
 * carries the fuller TCI field set across the whole slide and gives the
 * photographs a slide of their own.
 *
 * 16:9 at 10in × 5.625in, as v2.
 */
const SLIDE = { W: 10, H: 5.625 };

const LAYOUT = {
    ...SLIDE,
    MARGIN: 0.36,
    /** Below the slide title. */
    CONTENT_TOP: 0.68,
    /** Above the footer rule. */
    CONTENT_BOTTOM: 5.18,
    /** Gutter between the two spec columns, and between photographs. */
    GUTTER: 0.2,
};
LAYOUT.CONTENT_W = SLIDE.W - 2 * LAYOUT.MARGIN;
LAYOUT.CONTENT_H = LAYOUT.CONTENT_BOTTOM - LAYOUT.CONTENT_TOP;
LAYOUT.COL_W = (LAYOUT.CONTENT_W - LAYOUT.GUTTER) / 2;

// Montserrat weights are selected by naming them in the face string, since
// pptxgenjs passes fontFace through verbatim.
const FONT_SEMIBOLD = `${FONT} SemiBold`;
const FONT_EXTRABOLD = `${FONT} ExtraBold`;

/** Slide title, matching v2's detail-slide treatment. */
function addSlideTitle(slide, text) {
    slide.addText(text, {
        x: LAYOUT.MARGIN - 0.1, y: 0.16, w: 6.0, h: 0.42,
        fontFace: FONT_EXTRABOLD, fontSize: 13, bold: true, color: COLORS.navy,
    });
}

module.exports = { LAYOUT, COLORS, FONT, FONT_SEMIBOLD, FONT_EXTRABOLD, addSlideTitle };
