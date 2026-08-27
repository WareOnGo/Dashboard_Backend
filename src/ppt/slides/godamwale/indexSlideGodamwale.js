const { COLORS, FONT } = require('./themeGodamwale');
const { addContentHeader, addWatermark, addBottomBar } = require('./chromeGodamwale');
const { formatLocationText } = require('../../utils/textFormat');
const { formatHandover } = require('../../utils/handover');

function generateIndexSlideGodamwale(pptx, warehouses) {
    const slide = pptx.addSlide();
    slide.background = { color: COLORS.bg };

    slide.addText('INDEX', {
        x: 0.5, y: 0.395, w: 9.0, h: 0.6,
        fontFace: FONT, fontSize: 21, bold: true, color: COLORS.navy, align: 'center',
    });

    const headerCellOpts = {
        bold: true, color: COLORS.bg, fill: { color: COLORS.black },
        fontFace: FONT, fontSize: 8, align: 'center', valign: 'middle',
    };
    const headers = ['S.No', 'WH ID', 'Location', 'Quoted Monthly Rental (INR/Sq.ft)', 'Offered Area (Sq.ft)', 'Availability']
        .map((text) => ({ text, options: headerCellOpts }));

    const bodyCellBase = { fontFace: FONT, fontSize: 8, color: COLORS.navy, valign: 'middle', align: 'center' };

    const rows = warehouses.map((w, i) => {
        const location = formatLocationText(w.address) || formatLocationText([w.city, w.state].filter(Boolean).join(', ')) || 'N/A';
        const area = Array.isArray(w.totalSpaceSqft) ? w.totalSpaceSqft.join(', ') : (w.totalSpaceSqft || 'N/A');
        return [
            { text: String(i + 1), options: bodyCellBase },
            { text: String(w.id), options: bodyCellBase },
            { text: location, options: bodyCellBase },
            { text: w.ratePerSqft != null ? `${w.ratePerSqft}/-` : 'On request', options: bodyCellBase },
            { text: String(area), options: bodyCellBase },
            { text: formatHandover(w), options: bodyCellBase },
        ];
    });

    slide.addTable([headers, ...rows], {
        x: 0.5, y: 1.135, w: 9.0,
        colW: [0.6, 0.8, 2.7, 2.0, 1.4, 1.5],
        rowH: 0.4,
        border: { type: 'solid', pt: 0.5, color: COLORS.divider },
        fill: { color: COLORS.bg },
    });

    addContentHeader(slide);
    addWatermark(slide);
    addBottomBar(slide);
}

module.exports = { generateIndexSlideGodamwale };
