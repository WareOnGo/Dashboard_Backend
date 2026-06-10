// src/utils/googleMaps/index.js

const { warmUpSession } = require('./session');
const {
  extractCoordinatesFromUrl,
  extractCoordsFromString,
  resolveViaCid,
} = require('./extractor');

/**
 * Geocode a single Google Maps URL to coordinates.
 *
 * Warms up a browser-like session (best-effort) and resolves the URL,
 * including shortened share links. Returns just lat/lng; both are null
 * when no coordinates could be extracted.
 *
 * @param {string} url - any Google Maps URL (full, share, or shortened)
 * @returns {Promise<{lat: number|null, lng: number|null}>}
 */
async function geocodeUrl(url) {
  try {
    await warmUpSession();
  } catch {
    // best-effort; direct URL parsing still works without a warm session
  }

  const { lat, lng } = await extractCoordinatesFromUrl(url);
  return { lat, lng };
}

module.exports = {
  geocodeUrl,
  warmUpSession,
  extractCoordinatesFromUrl,
  extractCoordsFromString,
  resolveViaCid,
};
