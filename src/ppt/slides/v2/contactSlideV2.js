const { COLORS, FONT } = require('./themeV2');
const { addFooter, addTopRightLogo } = require('./chromeV2');

/**
 * The closing contact slide.
 *
 * NO DEFAULT PERSON. This used to fall back to a named individual and their
 * personal mobile number when `customDetails` carried no POC — so every deck
 * generated without one, from any deck variant and any caller, published a real
 * person's private number to a client. Removed, and deliberately not replaced
 * with another name: the company website is the correct fallback, and a slide
 * with no named contact is a missing field, while a slide with the wrong person's
 * number is a disclosure.
 *
 * Whoever is presenting picks the POC in the dashboard. If they did not, the deck
 * says how to reach WareOnGo and nothing more.
 */
/**
 * Is this actually a phone number, or just a country code?
 *
 * The dashboard builds `+91` + digits, so a blank number field can arrive as the
 * bare prefix. Testing for "contains a digit" passes '+91' — it has two — and the
 * slide then offers the reader a two-digit phone number. Seven is comfortably
 * below any real subscriber number and comfortably above a country code.
 */
const isCallable = (value) => (String(value || '').match(/\d/g) || []).length >= 7;

function generateContactSlideV2(pptx, customDetails) {
    const slide = pptx.addSlide();
    slide.background = { color: COLORS.bg };

    const pocName = String((customDetails && customDetails.pocName) || '').trim();
    const pocContact = String((customDetails && customDetails.pocContact) || '').trim();
    const parts = [pocName, isCallable(pocContact) ? pocContact : ''].filter(Boolean);

    slide.addText(
        parts.length
            ? 'For more details (or) to schedule a site visit, please contact –'
            : 'For more details (or) to schedule a site visit, please get in touch –',
        {
            x: 0.375, y: 2.25, w: 9.0, h: 0.375,
            fontFace: FONT, fontSize: 12, color: COLORS.navy, align: 'center',
        },
    );

    if (parts.length) {
        // The separator is between the two, not appended to whichever exists, so a
        // name with no number does not trail a dangling pipe.
        const runs = [];
        parts.forEach((text, i) => {
            if (i > 0) runs.push({ text: '   |   ', options: {} });
            runs.push({ text, options: { bold: true } });
        });
        slide.addText(runs, {
            x: 0.375, y: 2.625, w: 9.0, h: 0.375,
            fontFace: FONT, fontSize: 17, color: COLORS.navy, align: 'center',
        });
    }

    slide.addText('www.wareongo.com', {
        // Moves up into the vacated line when there is no POC, so the slide does
        // not carry a hole where a name used to be.
        x: 0.385, y: parts.length ? 3.046 : 2.625, w: 9.0, h: 0.375,
        fontFace: FONT, fontSize: 17, bold: true, color: COLORS.navy, align: 'center',
    });

    addTopRightLogo(slide);
    addFooter(slide);
}

module.exports = { generateContactSlideV2 };
