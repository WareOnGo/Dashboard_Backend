const { COLORS, FONT, LOGO_PATH, formatDate } = require('./themeV2');

function addFooter(slide, opts = {}) {
    // Default: right-aligned in the photos column (detail / index / contact slides).
    // `variant: 'cover'` left-aligns it under the title block so it lines up
    // with the divider rule and "City · N Properties" line on the title slide,
    // instead of disappearing into the dark photo panel on the right.
    const isCover = opts.variant === 'cover';
    slide.addText(
        `Prepared by WareOnGo  |  Dated ${formatDate()}  |  Confidential`,
        isCover
            ? { x: 0.36, y: 5.22, w: 4.9, h: 0.28, fontFace: FONT, fontSize: 7.5, color: COLORS.navy, align: 'left' }
            // Right edge of the frame lands at x=9.65 so the visible text right
            // edge sits at ~9.55 (after the ~0.1" text-frame padding), flush
            // with the right edge of the photos region / index table.
            : { x: 4.65, y: 5.22, w: 5.0, h: 0.28, fontFace: FONT, fontSize: 7.5, color: COLORS.navy, align: 'right' }
    );
}

function addTopRightLogo(slide) {
    slide.addImage({ path: LOGO_PATH, x: 9.55, y: 0.05, w: 0.4, h: 0.4 });
}

module.exports = { addFooter, addTopRightLogo };
