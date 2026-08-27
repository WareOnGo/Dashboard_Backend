// ppt-slides/contactSlide.js
function generateContactSlide(pptx, customDetails) {
    const lastSlide = pptx.addSlide();
    lastSlide.background = { color: 'FFFFFF' };

    lastSlide.addText('For more details regarding these warehouses (or) to schedule site visits, please contact –', { x: 0.5, y: 3, w: '90%', h: 0.5, align: 'center', fontSize: 16, color: '363636' });

    // Use POC details from form, or defaults
    const pocName = customDetails.pocName || 'Dhaval Gupta';
    const pocContact = customDetails.pocContact || '+91 XXXXX XXXXX';

    lastSlide.addText([
        { text: pocName, options: { color: '0077CC', bold: true } },
        { text: ' | ', options: { color: '363636' } },
        { text: pocContact, options: { color: '0077CC', bold: true } }
    ], { x: 0.5, y: 3.5, w: '90%', h: 0.5, align: 'center', fontSize: 22 });
}

module.exports = { generateContactSlide };