const { COLORS, LAYOUT, TCI_LOGO_PATH } = require('./themeTci');

// Top-right TCI lockup + the two thin grey rules running under the title —
// these come from the template's slideLayout4 so every option slide repeats
// them. Reproduced here as drawing calls.
function addOptionSlideChrome(slide) {
    slide.addImage({ path: TCI_LOGO_PATH, x: 7.81, y: 0.15, w: 2.08, h: 0.29 });

    // Two thin grey rules under the title, spanning the content box so the table
    // and photo grid below line up with them exactly.
    for (const y of [1.07, 1.10]) {
        slide.addShape('rect', {
            x: LAYOUT.MARGIN, y, w: LAYOUT.CONTENT_W, h: 0.018,
            fill: { color: COLORS.rule }, line: { color: COLORS.rule, width: 0 },
        });
    }
}

// Title slide and thank-you slide skip the rules and use the larger logo
// treatment in the body, so we expose just the corner logo here for
// consistency if a caller wants it.
function addCornerLogo(slide) {
    slide.addImage({ path: TCI_LOGO_PATH, x: 7.81, y: 0.15, w: 2.08, h: 0.29 });
}

module.exports = {
    addOptionSlideChrome,
    addCornerLogo,
};
