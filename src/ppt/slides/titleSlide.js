const path = require('path');

const LOGO_PATH = path.join(__dirname, '..', 'assets', 'WOG_logo_Transparent.png');

function generateTitleSlide(pptx, warehouse, customDetails) {
    const titleSlide = pptx.addSlide();
    titleSlide.background = { color: 'FFFFFF' };

    titleSlide.addImage({
        path: LOGO_PATH,
        x: 4.5, y: 0.9, w: 4.0, h: 4.0,
    });

    // Use client name from form (support both clientName and companyName), or a default
    const clientName = customDetails.clientName || customDetails.companyName || 'Client Name';
    titleSlide.addText(`Warehouse options for ${clientName}`, { x: 0.5, y: 4.2, w: '90%', h: 0.5, fontFace: 'Arial', fontSize: 24, bold: true, align: 'center', color: '000000' });

    // Use client requirement from form, or a default
    const clientRequirement = customDetails.clientRequirement || `${warehouse.city || 'Area'}, ${warehouse.state || 'City Name'} - N/A sqft`;
    titleSlide.addText(clientRequirement, { x: 0.5, y: 4.7, w: '90%', h: 0.5, fontFace: 'Arial', fontSize: 18, bold: true, align: 'center', color: '000000' });
}

module.exports = { generateTitleSlide };