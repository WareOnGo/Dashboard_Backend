// src/utils/googleMaps/extractor.js

const { BROWSER_HEADERS } = require('./session');

/**
 * @typedef {Object} Coordinates
 * @property {number|null} lat
 * @property {number|null} lng
 * @property {string} [via] - which strategy produced the result
 * @property {string} [error]
 */

/**
 * Resolve coordinates for a Google Maps feature id (ftid / "0x..:0x..") via the
 * undocumented maps preview endpoint. Returns null if nothing usable is found.
 *
 * @param {string} ftid
 * @returns {Promise<{lat: number, lng: number}|null>}
 */
async function resolveViaCid(ftid) {
  const pbUrl =
    `https://www.google.com/maps/preview/place?authuser=0&hl=en&gl=in` +
    `&pb=!1m17!1s${ftid}!3m12!1m3!1d10000!2d77.5!3d13.0!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!4m2!3d13.0!4d77.5`;

  const r = await fetch(pbUrl, {
    headers: {
      ...BROWSER_HEADERS,
      Accept: 'application/json',
      Referer: 'https://www.google.com/maps',
    },
  });

  if (r.status !== 200) return null;

  const text = await r.text();
  const match = text.match(/\[null,null,(-?\d+\.\d{4,}),(-?\d+\.\d{4,})\]/);
  if (match) {
    return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
  }
  return null;
}

/**
 * Extract coordinates directly out of a Google Maps URL string using the
 * various encodings Maps uses (@lat,lng, !3d!4d, /search/, ll=, q=, DMS).
 *
 * @param {string} str
 * @returns {Coordinates|null}
 */
function extractCoordsFromString(str) {
  const m1 = str.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m1) return { lat: parseFloat(m1[1]), lng: parseFloat(m1[2]), via: 'url_@' };

  const m3 = str.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (m3) return { lat: parseFloat(m3[1]), lng: parseFloat(m3[2]), via: 'url_!3d!4d' };

  const m2 = str.match(/\/search\/(-?\d+\.?\d*),\s*\+?(-?\d+\.?\d*)/);
  if (m2) return { lat: parseFloat(m2[1]), lng: parseFloat(m2[2]), via: 'url_/search/' };

  const m4 = str.match(/ll=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m4) return { lat: parseFloat(m4[1]), lng: parseFloat(m4[2]), via: 'url_ll=' };

  const m5 = str.match(/q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m5) return { lat: parseFloat(m5[1]), lng: parseFloat(m5[2]), via: 'url_q=' };

  const dms = str.match(
    /(\d+)%C2%B0(\d+)'([\d.]+)%22([NS])\+(\d+)%C2%B0(\d+)'([\d.]+)%22([EW])/
  );
  if (dms) {
    let lat = parseFloat(dms[1]) + parseFloat(dms[2]) / 60 + parseFloat(dms[3]) / 3600;
    let lng = parseFloat(dms[5]) + parseFloat(dms[6]) / 60 + parseFloat(dms[7]) / 3600;
    if (dms[4] === 'S') lat = -lat;
    if (dms[8] === 'W') lng = -lng;
    return { lat, lng, via: 'url_dms' };
  }

  return null;
}

/**
 * Resolve coordinates from any Google Maps URL, including shortened share
 * links (goo.gl / share.google). Tries direct URL parsing first, then falls
 * back to a feature-id (CID) lookup. Always resolves; check `lat`/`lng` for
 * null and `via` for the strategy/failure reason.
 *
 * @param {string} url
 * @returns {Promise<Coordinates>}
 */
async function extractCoordinatesFromUrl(url) {
  let finalUrl = url;

  if (url.includes('goo.gl') || url.includes('share.google')) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        headers: BROWSER_HEADERS,
      });
      finalUrl = response.url;
    } catch {
      return { lat: null, lng: null, via: 'error_resolve' };
    }
  }

  const urlCoords = extractCoordsFromString(finalUrl);
  if (urlCoords) return urlCoords;

  const ftidMatch = finalUrl.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/);
  if (ftidMatch) {
    try {
      const cidCoords = await resolveViaCid(ftidMatch[1]);
      if (cidCoords) return { ...cidCoords, via: 'cid_lookup' };
    } catch {
      return { lat: null, lng: null, via: 'error_cid' };
    }
  }

  return { lat: null, lng: null, via: 'no_match' };
}

module.exports = {
  extractCoordinatesFromUrl,
  extractCoordsFromString,
  resolveViaCid,
};
