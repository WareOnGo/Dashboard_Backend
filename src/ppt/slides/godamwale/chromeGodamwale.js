const {
    GODAMWALE_LOGO_PATH,
    GODAMWALE_ICON_PATH,
    GODAMWALE_BAR_PATH,
    FONT,
} = require('./themeGodamwale');

// Title slide gets the full GODAMWALE lockup pinned to the top-left, mirroring
// the sample deck. Width preserves the 6.04 aspect of the source logo.
function addTitleHeader(slide) {
    slide.addImage({ path: GODAMWALE_LOGO_PATH, x: 0.30, y: 0.16, w: 2.0, h: 0.33 });
    slide.addText('TM', {
        x: 2.32, y: 0.13, w: 0.4, h: 0.18,
        fontFace: FONT, fontSize: 7, color: '191919',
    });
}

// Content slides use the icon-only mark at the top-left so the title row stays
// uncluttered, matching the sample's slide 2/3 layout.
function addContentHeader(slide) {
    slide.addImage({ path: GODAMWALE_ICON_PATH, x: 0.18, y: 0.17, w: 0.36, h: 0.36 });
}

// Faded GW icon bleeds in from the top-right corner — mirrors the sample
// deck where the mark sits mostly off-slide as a watermark.
function addWatermark(slide) {
    slide.addImage({
        path: GODAMWALE_ICON_PATH,
        x: 8.62, y: -0.77, w: 2.2, h: 2.2,
        transparency: 85,
    });
}

// Dark-red gradient bar across the bottom of content slides.
function addBottomBar(slide) {
    slide.addImage({ path: GODAMWALE_BAR_PATH, x: 0, y: 5.52, w: 10.0, h: 0.105 });
}

module.exports = {
    addTitleHeader,
    addContentHeader,
    addWatermark,
    addBottomBar,
};
