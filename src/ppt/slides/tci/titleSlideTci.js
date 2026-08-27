const path = require('path');
const { COLORS } = require('./themeTci');

// Title slide is a verbatim render of the source template's first slide,
// baked to PNG so the original artwork (truck + tagline + photo collage +
// brand banner) lands pixel-accurate. We just lay it as a full-bleed image.
const BAKED_PATH = path.join(__dirname, '..', '..', 'assets', 'tci_title_baked.png');

async function generateTitleSlideTci(pptx /*, warehouses, customDetails */) {
    const slide = pptx.addSlide();
    slide.background = { color: COLORS.bg };
    slide.addImage({ path: BAKED_PATH, x: 0, y: 0, w: 10, h: 7.5 });
}

module.exports = { generateTitleSlideTci };
