const { COLORS, FONT, TCI_LOGO_PATH } = require('./themeTci');

// Top-right TCI lockup + the two thin grey rules running under the title —
// these come from the template's slideLayout4 so every option slide repeats
// them. Reproduced here as drawing calls.
function addOptionSlideChrome(slide) {
    slide.addImage({ path: TCI_LOGO_PATH, x: 7.81, y: 0.15, w: 2.08, h: 0.29 });

    // Two thin grey rules under the title — they span essentially full slide
    // width in the source template, with a small left/right inset.
    slide.addShape('rect', {
        x: 0.17, y: 1.07, w: 9.55, h: 0.018,
        fill: { color: COLORS.rule }, line: { color: COLORS.rule, width: 0 },
    });
    slide.addShape('rect', {
        x: 0.17, y: 1.10, w: 9.55, h: 0.018,
        fill: { color: COLORS.rule }, line: { color: COLORS.rule, width: 0 },
    });
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
