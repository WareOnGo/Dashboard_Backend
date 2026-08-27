const { COLORS, FONT } = require('./themeV2');
const { addFooter, addTopRightLogo } = require('./chromeV2');

function generateContactSlideV2(pptx, customDetails) {
    const slide = pptx.addSlide();
    slide.background = { color: COLORS.bg };

    const pocName = customDetails.pocName || 'Dhaval Gupta';
    const pocContact = customDetails.pocContact || '+91 XXXXXXXXXX';

    slide.addText('For more details (or) to schedule a site visit, please contact –', {
        x: 0.375, y: 2.25, w: 9.0, h: 0.375,
        fontFace: FONT, fontSize: 12, color: COLORS.navy, align: 'center',
    });

    slide.addText(
        [
            { text: pocName, options: { bold: true } },
            { text: '   |   ', options: {} },
            { text: pocContact, options: { bold: true } },
        ],
        {
            x: 0.375, y: 2.625, w: 9.0, h: 0.375,
            fontFace: FONT, fontSize: 17, color: COLORS.navy, align: 'center',
        }
    );

    slide.addText('www.wareongo.com', {
        x: 0.385, y: 3.046, w: 9.0, h: 0.375,
        fontFace: FONT, fontSize: 17, bold: true, color: COLORS.navy, align: 'center',
    });

    addTopRightLogo(slide);
    addFooter(slide);
}

module.exports = { generateContactSlideV2 };
