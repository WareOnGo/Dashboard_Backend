const axios = require('axios');
const { logError, logWarn, logInfo } = require('../utils/logger');

/**
 * Retry helper function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum number of retries (default: 1)
 * @param {number} baseDelay - Base delay in ms (default: 500)
 * @returns {Promise} Result of the function or null on failure
 */
async function retryWithBackoff(fn, maxRetries = 1, baseDelay = 500) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt); // Exponential backoff
        logWarn('geospatialService', 'retryWithBackoff', `Attempt ${attempt + 1} failed, retrying in ${delay}ms`, {
          error: error.message,
          attempt: attempt + 1,
          maxRetries: maxRetries + 1
        });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  // All retries failed
  logError('geospatialService', 'retryWithBackoff', 'All retry attempts failed', {
    error: lastError?.message,
    attempts: maxRetries + 1
  });
  return null;
}

// Rate limiter class for API throttling
class RateLimiter {
  constructor(requestsPerSecond) {
    this.delay = 1000 / requestsPerSecond;
    this.lastRequest = 0;
  }

  async throttle() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequest;
    if (timeSinceLastRequest < this.delay) {
      await new Promise(resolve =>
        setTimeout(resolve, this.delay - timeSinceLastRequest)
      );
    }
    this.lastRequest = Date.now();
  }
}

// In-memory cache with TTL
class Cache {
  constructor(ttl = 5 * 60 * 1000) {
    this.cache = new Map();
    this.ttl = ttl;
  }

  get(key) {
    const item = this.cache.get(key);
    if (item && Date.now() - item.timestamp < this.ttl) {
      return item.value;
    }
    this.cache.delete(key);
    return null;
  }

  set(key, value) {
    this.cache.set(key, { value, timestamp: Date.now() });
  }
}

// Initialize rate limiter and cache
const rateLimiter = new RateLimiter(1); // 1 request per second
const cache = new Cache();

// Configure axios instance with relaxed timeouts
const axiosInstance = axios.create({
  timeout: 20000, // 20 seconds default per request
  headers: {
    'User-Agent': 'WarehousePPTGenerator/1.0'
  }
});

/**
 * Extract coordinates from Google Maps URL or coordinate string.
 * Supports many URL formats including shortened URLs, DMS, and geocoding fallback.
 * @param {string} googleLocation - Google Maps URL or coordinate string
 * @returns {Promise<{latitude: number, longitude: number} | null>}
 */
async function extractCoordinates(googleLocation) {
  if (!googleLocation || typeof googleLocation !== 'string') {
    return null;
  }

  try {
    let finalUrl = googleLocation;

    logInfo('geospatialService', 'extractCoordinates', 'Processing URL', { url: googleLocation });

    // If it's a shortened URL (goo.gl, maps.app.goo.gl, or share.google), resolve it first
    if (googleLocation.includes('goo.gl') || googleLocation.includes('share.google')) {
      try {
        const response = await axiosInstance.get(googleLocation, {
          maxRedirects: 10,
          validateStatus: (status) => status >= 200 && status < 400,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cookie': 'CONSENT=YES+; SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpXzIwMjMwMTEwLjA3X3AxLjhmGgJlbiACGgYIgLCjnwY;',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
          }
        });

        finalUrl = response.request?.res?.responseUrl ||
          response.request?.path ||
          response.headers?.location ||
          response.config?.url ||
          googleLocation;

        logInfo('geospatialService', 'extractCoordinates', 'Resolved shortened URL', {
          originalUrl: googleLocation,
          finalUrl: finalUrl
        });

        // If we got a search URL instead of a place URL, try to extract from HTML
        if (finalUrl.includes('google.com/maps?q=') || finalUrl.includes('google.com/search')) {
          const html = typeof response.data === 'string' ? response.data : '';

          // Look for meta refresh URL
          const metaRefresh = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"]*url=([^"']+)["']/i);
          if (metaRefresh) {
            finalUrl = metaRefresh[1];
            logInfo('geospatialService', 'extractCoordinates', 'Found meta refresh URL', { finalUrl });
          }

          // Look for canonical link
          const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
          if (canonical) {
            finalUrl = canonical[1];
            logInfo('geospatialService', 'extractCoordinates', 'Found canonical URL', { finalUrl });
          }

          // Look for any maps/place URL in the HTML
          const placeUrl = html.match(/https:\/\/www\.google\.com\/maps\/place\/[^"'\s]+@[\d.]+,[\d.]+[^"'\s]*/);
          if (placeUrl) {
            finalUrl = placeUrl[0];
            logInfo('geospatialService', 'extractCoordinates', 'Found place URL in HTML', { finalUrl });
          }
        }
      } catch (error) {
        logError('geospatialService', 'extractCoordinates', 'Failed to resolve shortened URL', {
          url: googleLocation,
          error: error.message,
          errorCode: error.code
        });
        return null;
      }
    }

    // Pattern 1: @lat,lng,zoom format (viewport center - most common in shared links)
    const pattern1 = /@(-?\d+\.\d+),(-?\d+\.\d+)/;
    const match1 = finalUrl.match(pattern1);
    if (match1) {
      logInfo('geospatialService', 'extractCoordinates', 'Found coordinates in @ format');
      return { latitude: parseFloat(match1[1]), longitude: parseFloat(match1[2]) };
    }

    // Pattern 2: /search/lat,lng format (from shortened URLs)
    const pattern2 = /\/search\/(-?\d+\.?\d*),\s*\+?(-?\d+\.?\d*)/;
    const match2 = finalUrl.match(pattern2);
    if (match2) {
      logInfo('geospatialService', 'extractCoordinates', 'Found coordinates in /search/ format');
      return { latitude: parseFloat(match2[1]), longitude: parseFloat(match2[2]) };
    }

    // Pattern 3: !3d!4d format (ACTUAL PIN LOCATION - most accurate for place URLs)
    const pattern3 = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/;
    const match3 = finalUrl.match(pattern3);
    if (match3) {
      logInfo('geospatialService', 'extractCoordinates', 'Found coordinates in !3d!4d format (pin location)');
      return { latitude: parseFloat(match3[1]), longitude: parseFloat(match3[2]) };
    }

    // Pattern 4: ll=lat,lng format
    const pattern4 = /ll=(-?\d+\.\d+),(-?\d+\.\d+)/;
    const match4 = finalUrl.match(pattern4);
    if (match4) {
      logInfo('geospatialService', 'extractCoordinates', 'Found coordinates in ll= format');
      return { latitude: parseFloat(match4[1]), longitude: parseFloat(match4[2]) };
    }

    // Pattern 5: q=lat,lng format
    const pattern5 = /q=(-?\d+\.\d+),(-?\d+\.\d+)/;
    const match5 = finalUrl.match(pattern5);
    if (match5) {
      logInfo('geospatialService', 'extractCoordinates', 'Found coordinates in q= format');
      return { latitude: parseFloat(match5[1]), longitude: parseFloat(match5[2]) };
    }

    // Pattern 6: Direct coordinate string "lat, lng"
    const coordMatch = finalUrl.match(/^(-?\d+\.?\d*),\s*(-?\d+\.?\d*)$/);
    if (coordMatch) {
      logInfo('geospatialService', 'extractCoordinates', 'Found direct coordinates');
      return { latitude: parseFloat(coordMatch[1]), longitude: parseFloat(coordMatch[2]) };
    }

    // Pattern 7: /place/lat,lon format
    const placeCoordMatch = finalUrl.match(/\/place\/(-?\d+\.?\d*),(-?\d+\.?\d*)/);
    if (placeCoordMatch) {
      logInfo('geospatialService', 'extractCoordinates', 'Found coordinates in /place/ format');
      return { latitude: parseFloat(placeCoordMatch[1]), longitude: parseFloat(placeCoordMatch[2]) };
    }

    // Pattern 8: DMS format (Degrees Minutes Seconds) - e.g., 19°51'58.8"N+75°28'24.0"E
    const dmsPattern = /(\d+)%C2%B0(\d+)'([\d.]+)%22([NS])\+(\d+)%C2%B0(\d+)'([\d.]+)%22([EW])/;
    const dmsMatch = finalUrl.match(dmsPattern);
    if (dmsMatch) {
      const latDeg = parseFloat(dmsMatch[1]);
      const latMin = parseFloat(dmsMatch[2]);
      const latSec = parseFloat(dmsMatch[3]);
      const latDir = dmsMatch[4];
      const lngDeg = parseFloat(dmsMatch[5]);
      const lngMin = parseFloat(dmsMatch[6]);
      const lngSec = parseFloat(dmsMatch[7]);
      const lngDir = dmsMatch[8];

      let lat = latDeg + latMin / 60 + latSec / 3600;
      let lng = lngDeg + lngMin / 60 + lngSec / 3600;

      if (latDir === 'S') lat = -lat;
      if (lngDir === 'W') lng = -lng;

      logInfo('geospatialService', 'extractCoordinates', 'Found coordinates in DMS format');
      return { latitude: lat, longitude: lng };
    }

    // Pattern 9 (LAST RESORT): Extract place name and geocode via Mapbox
    const placeNameMatch = finalUrl.match(/\/place\/([^\/]+)/);
    if (placeNameMatch) {
      const placeName = decodeURIComponent(placeNameMatch[1].replace(/\+/g, ' '));
      logWarn('geospatialService', 'extractCoordinates', 'No coordinates in URL, falling back to geocoding', { placeName });
      return await geocodePlaceName(placeName);
    }

    // Try ?q= query parameter for geocoding
    const queryPattern = /[?&]q=([^&]+)/;
    const queryMatch = finalUrl.match(queryPattern);
    if (queryMatch) {
      const placeName = decodeURIComponent(queryMatch[1].replace(/\+/g, ' '));
      // Only geocode if it's not coordinates (already handled above)
      if (!/^-?\d+\.?\d*,\s*-?\d+\.?\d*$/.test(placeName)) {
        logWarn('geospatialService', 'extractCoordinates', 'Falling back to geocoding from query', { placeName });
        return await geocodePlaceName(placeName);
      }
    }

    logWarn('geospatialService', 'extractCoordinates', 'No coordinates found in URL', { url: finalUrl });
    return null;
  } catch (error) {
    logError('geospatialService', 'extractCoordinates', 'Error extracting coordinates', {
      googleLocation,
      error: error.message
    });
    return null;
  }
}

/**
 * Geocode a place name to coordinates using Mapbox Geocoding API (last resort fallback)
 * @param {string} placeName - Place name to geocode
 * @returns {Promise<{latitude: number, longitude: number} | null>}
 */
async function geocodePlaceName(placeName) {
  const accessToken = process.env.MAPBOX_ACCESS_TOKEN;
  if (!accessToken) {
    logError('geospatialService', 'geocodePlaceName', 'MAPBOX_ACCESS_TOKEN not configured');
    return null;
  }

  try {
    // Clean up the place name
    let cleanedName = placeName.replace(/\([^)]*\)/g, '').trim();

    // If it contains commas, take first part + last 2 parts (place name + city/country)
    const parts = cleanedName.split(',').map(p => p.trim()).filter(p => p);
    if (parts.length > 3) {
      cleanedName = [parts[0], ...parts.slice(-2)].join(', ');
    }

    const encodedPlace = encodeURIComponent(cleanedName);
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodedPlace}.json?access_token=${accessToken}&limit=1`;
    const response = await axiosInstance.get(url, { timeout: 10000 });

    if (response.data.features && response.data.features.length > 0) {
      const [longitude, latitude] = response.data.features[0].center;
      logInfo('geospatialService', 'geocodePlaceName', 'Geocoded successfully', { placeName: cleanedName, latitude, longitude });
      return { latitude, longitude };
    }

    // Retry with just the last 2-3 parts (location info)
    if (parts.length > 1) {
      const locationOnly = parts.slice(-3).join(', ');
      const encodedLocation = encodeURIComponent(locationOnly);
      const url2 = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodedLocation}.json?access_token=${accessToken}&limit=1`;
      const response2 = await axiosInstance.get(url2, { timeout: 10000 });

      if (response2.data.features && response2.data.features.length > 0) {
        const [longitude, latitude] = response2.data.features[0].center;
        logInfo('geospatialService', 'geocodePlaceName', 'Geocoded (location-only) successfully', { placeName: locationOnly, latitude, longitude });
        return { latitude, longitude };
      }
    }

    logWarn('geospatialService', 'geocodePlaceName', 'Could not geocode place name', { placeName });
  } catch (error) {
    logError('geospatialService', 'geocodePlaceName', 'Failed to geocode place name', { placeName, error: error.message });
  }

  return null;
}

/**
 * Calculate distance between two coordinates using Haversine formula
 * @param {number} lat1 - Latitude of first point
 * @param {number} lon1 - Longitude of first point
 * @param {number} lat2 - Latitude of second point
 * @param {number} lon2 - Longitude of second point
 * @returns {number} Distance in kilometers rounded to 1 decimal place
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return Math.round(distance * 10) / 10; // Round to 1 decimal place
}

function toRadians(degrees) {
  return degrees * (Math.PI / 180);
}

/**
 * Find nearest airport using Nominatim API (more reliable than Overpass)
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @returns {Promise<{name: string, distance: number} | null>}
 */
async function findNearestAirport(lat, lon) {
  const cacheKey = `airport:${lat},${lon}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const result = await retryWithBackoff(async () => {
    await rateLimiter.throttle();

    // Use Nominatim reverse geocoding to search for airports
    // Search within ~100km radius
    const response = await axiosInstance.get(
      'https://nominatim.openstreetmap.org/search',
      {
        params: {
          q: 'airport',
          format: 'json',
          limit: 10,
          viewbox: `${lon - 1},${lat - 1},${lon + 1},${lat + 1}`,
          bounded: 1
        },
        headers: {
          'User-Agent': 'WarehousePPTGenerator/1.0'
        },
        timeout: 7000
      }
    );

    if (!response.data || response.data.length === 0) {
      // Fallback: try wider search without bounds
      const fallbackResponse = await axiosInstance.get(
        'https://nominatim.openstreetmap.org/search',
        {
          params: {
            q: `airport near ${lat},${lon}`,
            format: 'json',
            limit: 5
          },
          headers: {
            'User-Agent': 'WarehousePPTGenerator/1.0'
          },
          timeout: 7000
        }
      );

      if (!fallbackResponse.data || fallbackResponse.data.length === 0) {
        logWarn('geospatialService', 'findNearestAirport', 'No airports found near coordinates', {
          lat,
          lon
        });
        cache.set(cacheKey, null);
        return null;
      }

      response.data = fallbackResponse.data;
    }

    let nearest = null;
    let minDistance = Infinity;

    for (const place of response.data) {
      if (place.lat && place.lon) {
        const placeLat = parseFloat(place.lat);
        const placeLon = parseFloat(place.lon);
        const distance = calculateDistance(lat, lon, placeLat, placeLon);

        if (distance < minDistance && distance < 200) { // Within 200km
          minDistance = distance;
          nearest = {
            name: place.display_name?.split(',')[0] || 'Airport',
            distance: distance
          };
        }
      }
    }

    cache.set(cacheKey, nearest);
    return nearest;
  });

  if (result === null) {
    cache.set(cacheKey, null);
  }

  return result;
}

/**
 * Find nearest highway (National or State) using Overpass API
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @returns {Promise<{name: string, distance: number} | null>}
 */
async function findNearestHighway(lat, lon) {
  const cacheKey = `highway:${lat},${lon}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const result = await retryWithBackoff(async () => {
    await rateLimiter.throttle();

    // Search for National Highways (NH) and State Highways (SH) within 100km
    // Using ref tag to identify NH and SH roads
    const query = `
      [out:json][timeout:25];
      (
        way["highway"~"motorway|trunk|primary"]["ref"~"NH"](around:100000,${lat},${lon});
        way["highway"~"motorway|trunk|primary"]["ref"~"SH"](around:100000,${lat},${lon});
        way["highway"~"motorway|trunk"]["name"~"National Highway"](around:100000,${lat},${lon});
        way["highway"~"motorway|trunk"]["name"~"State Highway"](around:100000,${lat},${lon});
      );
      out center 20;
    `;

    const response = await axiosInstance.post(
      'https://overpass-api.de/api/interpreter',
      query,
      {
        headers: { 'Content-Type': 'text/plain' },
        timeout: 15000 // 15 seconds
      }
    );

    if (!response.data || !response.data.elements || response.data.elements.length === 0) {
      logWarn('geospatialService', 'findNearestHighway', 'No highways found near coordinates', {
        lat,
        lon
      });
      cache.set(cacheKey, null);
      return null;
    }

    let nearest = null;
    let minDistance = Infinity;

    for (const element of response.data.elements) {
      let centerLat, centerLon;

      if (element.center) {
        centerLat = element.center.lat;
        centerLon = element.center.lon;
      } else if (element.bounds) {
        centerLat = (element.bounds.minlat + element.bounds.maxlat) / 2;
        centerLon = (element.bounds.minlon + element.bounds.maxlon) / 2;
      }

      if (centerLat && centerLon) {
        const distance = calculateDistance(lat, lon, centerLat, centerLon);

        if (distance < minDistance) {
          minDistance = distance;

          // Extract highway name/ref
          let highwayName = 'Highway';
          if (element.tags?.ref) {
            highwayName = element.tags.ref;
          } else if (element.tags?.name) {
            // Extract NH/SH number from name if present
            const match = element.tags.name.match(/(NH|SH)[\s-]*(\d+)/i);
            if (match) {
              highwayName = `${match[1].toUpperCase()}-${match[2]}`;
            } else {
              highwayName = element.tags.name;
            }
          }

          nearest = {
            name: highwayName,
            distance: distance
          };
        }
      }
    }

    if (nearest) {
      logInfo('geospatialService', 'findNearestHighway', 'Found nearest highway', {
        lat,
        lon,
        highway: nearest.name,
        distance: nearest.distance
      });
    }

    cache.set(cacheKey, nearest);
    return nearest;
  });

  if (result === null) {
    cache.set(cacheKey, null);
  }

  return result;
}

/**
 * Find nearest railway station using Overpass API
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @returns {Promise<{name: string, distance: number} | null>}
 */
async function findNearestRailwayStation(lat, lon) {
  const cacheKey = `railway:${lat},${lon}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const result = await retryWithBackoff(async () => {
    await rateLimiter.throttle();

    // Simplified query - search for railway stations within 100km
    const query = `
      [out:json][timeout:25];
      node["railway"="station"](around:100000,${lat},${lon});
      out 10;
    `;

    const response = await axiosInstance.post(
      'https://overpass-api.de/api/interpreter',
      query,
      {
        headers: { 'Content-Type': 'text/plain' },
        timeout: 15000 // 15 seconds
      }
    );

    if (!response.data || !response.data.elements || response.data.elements.length === 0) {
      logWarn('geospatialService', 'findNearestRailwayStation', 'No railway stations found near coordinates', {
        lat,
        lon
      });
      cache.set(cacheKey, null);
      return null;
    }

    let nearest = null;
    let minDistance = Infinity;

    for (const element of response.data.elements) {
      if (element.lat && element.lon) {
        const distance = calculateDistance(lat, lon, element.lat, element.lon);
        if (distance < minDistance) {
          minDistance = distance;
          nearest = {
            name: element.tags?.name || 'Railway Station',
            distance: distance
          };
        }
      }
    }

    cache.set(cacheKey, nearest);
    return nearest;
  });

  if (result === null) {
    cache.set(cacheKey, null);
  }

  return result;
}

/**
 * Fetch satellite image from Mapbox Static Images API
 * Uses satellite-streets-v12 style (satellite imagery with street labels)
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {number} zoom - Zoom level (default: 16)
 * @returns {Promise<{imageBuffer: Buffer, contentType: string} | null>} Image buffer or null on error
 */
async function fetchSatelliteImageUrl(lat, lon, zoom = 14) {
  try {
    // Validate coordinates
    if (lat === null || lat === undefined || lon === null || lon === undefined || isNaN(lat) || isNaN(lon)) {
      logWarn('geospatialService', 'fetchSatelliteImageUrl', 'Invalid coordinates provided', { lat, lon });
      return null;
    }

    const accessToken = process.env.MAPBOX_ACCESS_TOKEN;
    if (!accessToken) {
      logError('geospatialService', 'fetchSatelliteImageUrl', 'MAPBOX_ACCESS_TOKEN not configured');
      return null;
    }

    const style = 'satellite-streets-v12';
    // Smaller base dimensions with @2x → labels, road names, and badges render larger.
    // Output is 960x910 pixels (480*2 x 455*2).
    // Zoom 14 shows ~5km radius — highways and major roads get thick, prominent lines.
    const width = 480;
    const height = 455;

    // Build Mapbox Static Images API URL
    // Dimensions match the PPT slot aspect ratio (~5.8:5.5) to avoid distortion
    // Using @2x for high-DPI AND proportionally larger labels/road lines
    // Using pin-l (large pin) for better visibility in the PPT
    const mapboxUrl = `https://api.mapbox.com/styles/v1/mapbox/${style}/static/pin-l+ff0000(${lon},${lat})/${lon},${lat},${zoom}/${width}x${height}@2x?access_token=${accessToken}`;

    logInfo('geospatialService', 'fetchSatelliteImageUrl', 'Fetching Mapbox satellite image', {
      lat, lon, zoom, style, width, height
    });

    // Download the image
    const response = await axiosInstance.get(mapboxUrl, {
      responseType: 'arraybuffer',
      timeout: 15000
    });

    const imageBuffer = Buffer.from(response.data);

    logInfo('geospatialService', 'fetchSatelliteImageUrl', 'Mapbox satellite image downloaded successfully', {
      lat, lon, zoom, bufferSize: imageBuffer.length
    });

    return {
      imageBuffer,
      contentType: 'image/jpeg'
    };
  } catch (error) {
    logError('geospatialService', 'fetchSatelliteImageUrl', 'Error fetching Mapbox satellite image', {
      lat, lon, zoom,
      error: error.message,
      statusCode: error.response?.status,
      stack: error.stack
    });
    return null;
  }
}

module.exports = {
  extractCoordinates,
  calculateDistance,
  findNearestAirport,
  findNearestHighway,
  findNearestRailwayStation,
  fetchSatelliteImageUrl
};
