// ppt-slides/contactSlide.js

/**
 * Is this actually a phone number, or just a country code?
 *
 * The dashboard builds `+91` + digits, so a blank number field can arrive as the
 * bare prefix. Testing for "contains a digit" passes '+91' — it has two — and the
 * slide then offers the reader a two-digit phone number. Seven is comfortably
 * below any real subscriber number and comfortably above a country code.
 */
const isCallable = (value) => (String(value || '').match(/\d/g) || []).length >= 7;
function generateContactSlide(pptx, customDetails) {
    const lastSlide = pptx.addSlide();
    lastSlide.background = { color: 'FFFFFF' };

    lastSlide.addText('For more details regarding these warehouses (or) to schedule site visits, please contact –', { x: 0.5, y: 3, w: '90%', h: 0.5, align: 'center', fontSize: 16, color: '363636' });

    // NO DEFAULT PERSON. This used to fall back to a named individual and their
    // personal mobile, so any deck generated without a POC published a real
    // person's private number to a client. The website is the correct fallback;
    // another name would only move the problem.
    const pocName = String((customDetails && customDetails.pocName) || '').trim();
    const pocContact = String((customDetails && customDetails.pocContact) || '').trim();
    const parts = [pocName, isCallable(pocContact) ? pocContact : ''].filter(Boolean);

    if (parts.length) {
        const runs = [];
        parts.forEach((text, i) => {
            if (i > 0) runs.push({ text: ' | ', options: { color: '363636' } });
            runs.push({ text, options: { color: '0077CC', bold: true } });
        });
        lastSlide.addText(runs, { x: 0.5, y: 3.5, w: '90%', h: 0.5, align: 'center', fontSize: 22 });
    } else {
        lastSlide.addText('www.wareongo.com',
            { x: 0.5, y: 3.5, w: '90%', h: 0.5, align: 'center', fontSize: 22, color: '0077CC', bold: true });
    }
}

module.exports = { generateContactSlide };