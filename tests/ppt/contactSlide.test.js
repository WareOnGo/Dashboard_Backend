const { generateContactSlideV2 } = require('../../src/ppt/slides/v2/contactSlideV2');
const { generateContactSlide } = require('../../src/ppt/slides/contactSlide');

/**
 * The closing contact slide, and the person it must not invent.
 *
 * Both of these fell back to a named individual and their personal mobile number
 * when no POC was supplied, so every deck generated without one published a real
 * person's private number — and both repositories are public, so the number was
 * also readable in the source. These tests exist so a "sensible default" cannot be
 * reintroduced by someone who has not seen this comment.
 */

const render = (fn, customDetails) => {
    const texts = [];
    const slide = {
        addText: (t) => texts.push(Array.isArray(t) ? t.map((r) => r.text).join('') : String(t)),
        addImage: () => {},
        addShape: () => {},
        set background(v) { this._bg = v; },
        get background() { return this._bg; },
    };
    fn({ addSlide: () => slide, shapes: {} }, customDetails);
    return texts.join('\n');
};

describe.each([
    ['v2/v3', generateContactSlideV2],
    ['standard', generateContactSlide],
])('%s contact slide', (label, fn) => {
    test('invents no person when none is supplied', () => {
        const out = render(fn, {});
        // Not "no phone number appears" but "no digits at all", so a hardcoded
        // number in any format is caught rather than just the one that was there.
        expect(out).not.toMatch(/\d{5}/);
        expect(out).toContain('www.wareongo.com');
    });

    test('a country code on its own is not a contact', () => {
        // The dashboard builds `+91` + digits, so a blank field arrives as the bare
        // prefix. Rendering it offers the reader a two-digit phone number.
        for (const contact of ['+91', ' +91 ', '+91 ']) {
            expect(render(fn, { pocContact: contact })).not.toContain('+91');
        }
    });

    test('a supplied POC is shown', () => {
        const out = render(fn, { pocName: 'Test POC', pocContact: '+91 9999999999' });
        expect(out).toContain('Test POC');
        expect(out).toContain('+91 9999999999');
    });

    test('a name with no number does not trail a separator', () => {
        const out = render(fn, { pocName: 'Test POC' });
        expect(out).toContain('Test POC');
        expect(out).not.toMatch(/Test POC\s*\|/);
    });

    test('a number with no name does not lead with a separator', () => {
        const out = render(fn, { pocContact: '+91 9999999999' });
        expect(out).not.toMatch(/\|\s*\+91/);
    });

    test('tolerates being called with nothing at all', () => {
        expect(() => render(fn, undefined)).not.toThrow();
        expect(() => render(fn, null)).not.toThrow();
    });
});
