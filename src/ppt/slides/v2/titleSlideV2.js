const { COLORS, FONT, LOGO_PATH, COVER_HERO_PATH } = require('./themeV2');
const { addFooter } = require('./chromeV2');

async function generateTitleSlideV2(pptx, warehouses, customDetails) {
    const slide = pptx.addSlide();
    slide.background = { color: COLORS.bg };

    // Cover hero is always the baked-in asset — every deck ships with the same
    // hero, independent of which warehouse photos the user picked.
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

    slide.addImage({ path: LOGO_PATH, x: 0.16, y: 0.2, w: 1.6, h: 1.6 });

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
        fill: { color: COLORS.navy }, line: { color: COLORS.navy, width: 0 },
    });
    slide.addShape(pptx.shapes.RECTANGLE, {
        x: 0.896, y: 4.22, w: 3.3, h: 0.055,
        fill: { color: COLORS.divider }, line: { color: COLORS.divider, width: 0 },
    });

    const city = warehouses[0]?.city || 'Location';
    const count = warehouses.length;
    slide.addText(
        `${city}   ·   ${count} ${count === 1 ? 'Property' : 'Properties'}`,
        // Same x as the title frame above so the visual left edges line up —
        // both frames inherit the default ~0.1" text padding.
        { x: 0.36, y: 4.42, w: 3.886, h: 0.44, fontFace: FONT, fontSize: 11, color: COLORS.navy }
    );

    addFooter(slide, { variant: 'cover' });
}

module.exports = { generateTitleSlideV2 };
