const { COLORS, FONT, COVER_HERO_PATH } = require('./themeGodamwale');
const { addTitleHeader, addWatermark } = require('./chromeGodamwale');

async function generateTitleSlideGodamwale(pptx, warehouses, customDetails) {
    const slide = pptx.addSlide();
    slide.background = { color: COLORS.bg };

    slide.addImage({ path: COVER_HERO_PATH, x: 5.6, y: 0.0, w: 4.4, h: 5.625, sizing: { type: 'cover', w: 4.4, h: 5.625 } });

    slide.addShape(pptx.shapes.RECTANGLE, {
        x: 5.6, y: 0.0, w: 4.4, h: 5.625,
        fill: { color: COLORS.navyDark, transparency: 30 },
        line: { color: COLORS.navyDark, width: 0 },
    });

    slide.addShape(pptx.shapes.RECTANGLE, {
        x: 5.6, y: 0.0, w: 0.06, h: 5.625,
        fill: { color: COLORS.divider },
        line: { color: COLORS.divider, width: 0 },
    });

    addTitleHeader(slide);
    addWatermark(slide);

    const clientName = customDetails.clientName || customDetails.companyName || 'Client Name';
    slide.addText(
        [
            { text: 'Warehouse Options', options: { bold: true, breakLine: true } },
            { text: 'for ', options: { bold: true } },
            { text: clientName, options: { bold: true } },
        ],
        { x: 0.36, y: 2.441, w: 5.15, h: 1.45, fontFace: FONT, fontSize: 30, color: COLORS.navy, valign: 'top' }
    );

    slide.addShape(pptx.shapes.RECTANGLE, {
        x: 0.44, y: 4.22, w: 0.5, h: 0.055,
        fill: { color: COLORS.brandRed }, line: { color: COLORS.brandRed, width: 0 },
    });
    slide.addShape(pptx.shapes.RECTANGLE, {
        x: 0.896, y: 4.22, w: 3.3, h: 0.055,
        fill: { color: COLORS.divider }, line: { color: COLORS.divider, width: 0 },
    });

    const city = warehouses[0]?.city || 'Location';
    const count = warehouses.length;
    slide.addText(
        `${city}   ·   ${count} ${count === 1 ? 'Property' : 'Properties'}`,
        { x: 0.36, y: 4.42, w: 3.886, h: 0.44, fontFace: FONT, fontSize: 11, color: COLORS.navy }
    );

}

module.exports = { generateTitleSlideGodamwale };
