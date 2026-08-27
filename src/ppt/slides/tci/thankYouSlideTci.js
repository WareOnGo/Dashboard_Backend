const path = require('path');
const { COLORS } = require('./themeTci');

// Closing slide is also baked from the source template's last slide so the
// "Thank You" mark, icon-pattern backdrop, and WAREHOUSE badge match the
// original exactly.
const BAKED_PATH = path.join(__dirname, '..', '..', 'assets', 'tci_thankyou_baked.png');

function generateThankYouSlideTci(pptx) {
    const slide = pptx.addSlide();
    slide.background = { color: COLORS.bg };
    slide.addImage({ path: BAKED_PATH, x: 0, y: 0, w: 10, h: 7.5 });
}

module.exports = { generateThankYouSlideTci };
