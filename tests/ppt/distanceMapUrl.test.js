const { buildComparisonMapUrl, parseClientLocation } = require('../../src/ppt/slides/v3/distanceSlideV3');

/**
 * The v3 distance slide draws a driving route per option on one static map. The
 * Static Images API refuses requests over 8,192 characters, and an encoded route
 * costs roughly 300 of them, so a long enough deck has to fall back to plain
 * markers rather than sending a request that will be rejected.
 *
 * That fallback fires only on unusually long decks, which is precisely why it is
 * tested here rather than left to be discovered in production.
 */

const TOKEN = 'pk.test-token';
const pins = ['pin-l-star+C0392B(78.3772,17.4435)', 'pin-s-1+1A3350(78.5031,17.5756)'];
const args = (paths) => ({ token: TOKEN, paths, pins, width: 640, height: 700 });

// Roughly the size of a real simplified route once percent-encoded.
const route = (n) => `path-2+1A3350-0.75(${'a'.repeat(n)})`;

describe('comparison map URL', () => {
    test('keeps the routes when they fit', () => {
        const result = buildComparisonMapUrl(args([route(280), route(300)]));

        expect(result.withPaths).toBe(true);
        expect(result.url).toContain('path-2');
        expect(result.url.length).toBeLessThanOrEqual(8192);
    });

    test('drops the routes rather than sending a request that would be refused', () => {
        // 30 routes at ~300 characters each is comfortably past the limit.
        const many = Array.from({ length: 30 }, () => route(300));
        const result = buildComparisonMapUrl(args(many));

        expect(result.withPaths).toBe(false);
        expect(result.url).not.toContain('path-2');
        expect(result.url.length).toBeLessThanOrEqual(8192);
        // The reported length is the attempted one, so the log explains the fallback.
        expect(result.urlLength).toBeGreaterThan(8192);
    });

    test('still keeps the markers when the routes are dropped', () => {
        const result = buildComparisonMapUrl(args(Array.from({ length: 30 }, () => route(300))));

        expect(result.url).toContain('pin-l-star');
        expect(result.url).toContain('pin-s-1');
    });

    test('is a plain marker map when there are no routes at all', () => {
        const result = buildComparisonMapUrl(args([]));

        expect(result.withPaths).toBe(false);
        expect(result.url).toContain('pin-l-star');
    });
});

describe('client location parsing', () => {
    test.each([
        ['numbers', { lat: 17.4435, lng: 78.3772 }],
        ['strings from a form field', { lat: '17.4435', lng: '78.3772' }],
        ['latitude/longitude spelling', { latitude: 17.4435, longitude: 78.3772 }],
    ])('accepts %s', (_label, input) => {
        expect(parseClientLocation(input)).toMatchObject({ lat: 17.4435, lng: 78.3772 });
    });

    test.each([
        ['nothing', null],
        ['a non-object', 'somewhere'],
        ['unparsable values', { lat: 'here', lng: 'there' }],
        ['an out-of-range latitude', { lat: 200, lng: 78 }],
        ['an out-of-range longitude', { lat: 17, lng: 999 }],
        ['a missing longitude', { lat: 17.4435 }],
    ])('refuses %s', (_label, input) => {
        expect(parseClientLocation(input)).toBeNull();
    });

    test('falls back to a generic label', () => {
        expect(parseClientLocation({ lat: 17, lng: 78 }).label).toBe('Client site');
    });
});
