const { resolveViaCid } = require('./extractor');

const GOOGLE_DOMAINS = new Set(['google.com', 'google.co.in', 'google.co.uk', 'google.com.au',
    'google.ca', 'google.de', 'google.fr', 'google.co.jp', 'google.com.sg', 'google.ae']);
const fail = (message, statusCode = 422, field = 'googleLocation') => Object.assign(new Error(message), {
    name: 'LocationValidationError', statusCode, issues: [{ path: [field], message }],
});

function mapsUrl(value) {
    if (typeof value !== 'string' || value.length > 4096) throw fail('Enter a Google Maps location link.', 400);
    let url;
    try { url = new URL(value.trim()); } catch { throw fail('Enter a complete Google Maps location link.', 400); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) {
        throw fail('Enter a Google Maps location link.', 400);
    }
    const host = url.hostname.toLowerCase();
    const base = host.replace(/^(www|maps)\./, '');
    const longLink = GOOGLE_DOMAINS.has(base) && (host.startsWith('maps.') || /^\/maps(?:\/|$)/.test(url.pathname));
    const shortLink = host === 'maps.app.goo.gl' || host === 'share.google' || host === 'goo.gl' && url.pathname.startsWith('/maps/');
    if (!longLink && !shortLink) throw fail('Use a Google Maps place or dropped-pin link.', 400);
    url.protocol = 'https:';
    return url;
}

const validCoordinates = point => point && Number.isFinite(point.lat) && Number.isFinite(point.lng)
    && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180;
const pair = value => {
    const match = value?.trim().match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
    return match ? { lat: Number(match[1]), lng: Number(match[2]) } : null;
};
const placeData = url => decodeURIComponent(url.pathname).match(/\/data=([^/]+)(?:\/|$)/)?.[1]
    || url.searchParams.get('data') || '';

function directPin(url) {
    let path;
    try { path = decodeURIComponent(url.pathname); }
    catch { throw fail('The Maps link has invalid encoding. Copy the link again.'); }
    // Directions and Street View URLs can carry several coordinates. A place ID
    // overrides query coordinates in Maps, so that fallback is not a verified pin.
    if ((!/^\/maps(?:\/?$|\/(?:place\/|search\/|@))/.test(path) && path !== '/') || url.searchParams.has('map_action')) {
        throw fail('Use a single place or dropped-pin link, rather than directions or a map view.');
    }
    if (url.searchParams.get('query_place_id') || url.searchParams.get('cid')) {
        throw fail('This place-ID link cannot be verified. Copy the full place link or share a dropped pin.');
    }
    const data = placeData(url);
    const pins = [...data.matchAll(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)(?=!|$)/g)];
    if (pins.length > 1) throw fail('This link contains multiple pins. Share just the warehouse pin.');
    if (pins.length === 1) return { lat: Number(pins[0][1]), lng: Number(pins[0][2]) };
    const queries = [...url.searchParams.getAll('query'), ...url.searchParams.getAll('q')];
    if (queries.length) return queries.length === 1 ? pair(queries[0]) : null;
    const place = path.match(/^\/maps\/(?:search|place)\/([^/]+)/)?.[1];
    const point = pair(place?.replaceAll('+', ' '));
    if (point) return point;
    const dms = place?.match(/^(\d+)°(\d+)'(\d+(?:\.\d+)?)"([NS])[+\s]+(\d+)°(\d+)'(\d+(?:\.\d+)?)"([EW])$/i);
    if (dms && [2, 3, 6, 7].every(i => Number(dms[i]) < 60)) {
        const coordinate = (offset, negative) => (Number(dms[offset]) + Number(dms[offset + 1]) / 60 + Number(dms[offset + 2]) / 3600)
            * (dms[offset + 3].toUpperCase() === negative ? -1 : 1);
        return { lat: coordinate(1, 'S'), lng: coordinate(5, 'W') };
    }
    return null;
}

async function resolvePin(value, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
    let url = mapsUrl(value);
    const signal = AbortSignal.timeout(timeoutMs);
    try {
        for (let redirects = 0; redirects <= 5; redirects++) {
            const shortLink = ['maps.app.goo.gl', 'goo.gl', 'share.google'].includes(url.hostname);
            const point = shortLink ? null : directPin(url);
            if (point) {
                if (!validCoordinates(point)) throw fail('The location coordinates are outside the valid range.');
                return { latitude: point.lat, longitude: point.lng,
                    mapsUrl: `https://www.google.com/maps/search/?api=1&query=${point.lat},${point.lng}` };
            }
            const ftid = !shortLink && placeData(url).match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)(?=!|$)/i)?.[1];
            if (ftid) {
                const resolved = await resolveViaCid(ftid, { signal, fetchImpl });
                if (validCoordinates(resolved)) return { latitude: resolved.lat, longitude: resolved.lng,
                    mapsUrl: `https://www.google.com/maps/search/?api=1&query=${resolved.lat},${resolved.lng}` };
            }
            if (!shortLink) break;
            if (redirects === 5) throw fail('This Maps link redirects too many times. Paste the full place link.');
            const response = await fetchImpl(url.toString(), { redirect: 'manual', signal });
            const target = response.headers.get('location');
            // Cancel unused response bodies before following another redirect.
            await response.body?.cancel();
            if ([301, 302, 303, 307, 308].includes(response.status) && target) {
                url = mapsUrl(new URL(target, url).toString());
            } else if (response.status >= 500 || response.status === 429) {
                throw fail('Google Maps could not be reached. Please retry.', 503);
            } else break;
        }
    } catch (error) {
        if (error.statusCode) throw error;
        throw fail('Could not check this location right now. Please retry.', 503);
    }
    throw fail('This link does not identify a location pin. Share a place or drop a pin in Google Maps.');
}

module.exports = { resolvePin, mapsUrl, directPin };
