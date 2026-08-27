const geospatialService = require('../../src/ppt/services/geospatialService');

describe('GeospatialService - Coordinate Extraction', () => {
  test('should extract coordinates from standard Google Maps URL with ?q= parameter', async () => {
    const url = 'https://maps.google.com/?q=28.7041,77.1025';
    const result = await geospatialService.extractCoordinates(url);

    expect(result).not.toBeNull();
    expect(result.latitude).toBe(28.7041);
    expect(result.longitude).toBe(77.1025);
  });

  test('should extract coordinates from Google Maps URL with @ format', async () => {
    const url = 'https://www.google.com/maps/place/New+Delhi/@28.7041,77.1025,17z/data=xyz';
    const result = await geospatialService.extractCoordinates(url);

    expect(result).not.toBeNull();
    expect(result.latitude).toBe(28.7041);
    expect(result.longitude).toBe(77.1025);
  });

  test('should extract coordinates from direct coordinate string', async () => {
    const coords = '28.7041, 77.1025';
    const result = await geospatialService.extractCoordinates(coords);

    expect(result).not.toBeNull();
    expect(result.latitude).toBe(28.7041);
    expect(result.longitude).toBe(77.1025);
  });

  test('should extract coordinates from direct coordinate string without spaces', async () => {
    const coords = '28.7041,77.1025';
    const result = await geospatialService.extractCoordinates(coords);

    expect(result).not.toBeNull();
    expect(result.latitude).toBe(28.7041);
    expect(result.longitude).toBe(77.1025);
  });

  test('should handle negative coordinates', async () => {
    const coords = '-33.8688, 151.2093';
    const result = await geospatialService.extractCoordinates(coords);

    expect(result).not.toBeNull();
    expect(result.latitude).toBe(-33.8688);
    expect(result.longitude).toBe(151.2093);
  });

  test('should extract coordinates from !3d!4d format (pin location)', async () => {
    const url = 'https://www.google.com/maps/place/Some+Place/data=!3m1!4b1!4m2!3m1!1s0x0!3d28.7041!4d77.1025';
    const result = await geospatialService.extractCoordinates(url);

    expect(result).not.toBeNull();
    expect(result.latitude).toBe(28.7041);
    expect(result.longitude).toBe(77.1025);
  });

  test('should extract coordinates from ll= format', async () => {
    const url = 'https://maps.google.com/?ll=28.7041,77.1025&z=15';
    const result = await geospatialService.extractCoordinates(url);

    expect(result).not.toBeNull();
    expect(result.latitude).toBe(28.7041);
    expect(result.longitude).toBe(77.1025);
  });

  test('should extract coordinates from /search/ format', async () => {
    const url = 'https://www.google.com/maps/search/28.7041,77.1025';
    const result = await geospatialService.extractCoordinates(url);

    expect(result).not.toBeNull();
    expect(result.latitude).toBe(28.7041);
    expect(result.longitude).toBe(77.1025);
  });

  test('should extract coordinates from /place/lat,lon format', async () => {
    const url = 'https://www.google.com/maps/place/28.7041,77.1025';
    const result = await geospatialService.extractCoordinates(url);

    expect(result).not.toBeNull();
    expect(result.latitude).toBe(28.7041);
    expect(result.longitude).toBe(77.1025);
  });

  test('should extract coordinates from DMS format', async () => {
    // 19°51'58.8"N+75°28'24.0"E -> lat ~19.8663, lon ~75.4733
    const url = 'https://www.google.com/maps/place/19%C2%B051\'58.8%22N+75%C2%B028\'24.0%22E';
    const result = await geospatialService.extractCoordinates(url);

    expect(result).not.toBeNull();
    expect(result.latitude).toBeCloseTo(19.8663, 3);
    expect(result.longitude).toBeCloseTo(75.4733, 3);
  });

  test('should return null for invalid input', async () => {
    const result = await geospatialService.extractCoordinates('invalid string');
    expect(result).toBeNull();
  });

  test('should return null for null input', async () => {
    const result = await geospatialService.extractCoordinates(null);
    expect(result).toBeNull();
  });

  test('should return null for undefined input', async () => {
    const result = await geospatialService.extractCoordinates(undefined);
    expect(result).toBeNull();
  });

  test('should return null for empty string', async () => {
    const result = await geospatialService.extractCoordinates('');
    expect(result).toBeNull();
  });

  test('should return null for non-string input', async () => {
    const result = await geospatialService.extractCoordinates(12345);
    expect(result).toBeNull();
  });
});

describe('GeospatialService - Distance Calculations', () => {
  test('should calculate distance between New Delhi and Mumbai correctly', () => {
    // New Delhi coordinates
    const lat1 = 28.7041;
    const lon1 = 77.1025;

    // Mumbai coordinates
    const lat2 = 19.0760;
    const lon2 = 72.8777;

    const distance = geospatialService.calculateDistance(lat1, lon1, lat2, lon2);

    // Expected distance is approximately 1150-1160 km
    expect(distance).toBeGreaterThan(1140);
    expect(distance).toBeLessThan(1170);
  });

  test('should calculate distance between London and Paris correctly', () => {
    // London coordinates
    const lat1 = 51.5074;
    const lon1 = -0.1278;

    // Paris coordinates
    const lat2 = 48.8566;
    const lon2 = 2.3522;

    const distance = geospatialService.calculateDistance(lat1, lon1, lat2, lon2);

    // Expected distance is approximately 340-350 km
    expect(distance).toBeGreaterThan(330);
    expect(distance).toBeLessThan(360);
  });

  test('should return 0 for same location', () => {
    const lat = 28.7041;
    const lon = 77.1025;

    const distance = geospatialService.calculateDistance(lat, lon, lat, lon);

    expect(distance).toBe(0);
  });

  test('should handle antipodal points correctly', () => {
    // Point in India
    const lat1 = 28.7041;
    const lon1 = 77.1025;

    // Approximate antipodal point
    const lat2 = -28.7041;
    const lon2 = -102.8975; // 180 degrees opposite

    const distance = geospatialService.calculateDistance(lat1, lon1, lat2, lon2);

    // Distance should be close to half Earth's circumference (approximately 20,000 km)
    expect(distance).toBeGreaterThan(19000);
    expect(distance).toBeLessThan(21000);
  });

  test('should return distance rounded to 1 decimal place', () => {
    const lat1 = 28.7041;
    const lon1 = 77.1025;
    const lat2 = 28.7141;
    const lon2 = 77.1125;

    const distance = geospatialService.calculateDistance(lat1, lon1, lat2, lon2);

    // Check that result has at most 1 decimal place
    const decimalPlaces = (distance.toString().split('.')[1] || '').length;
    expect(decimalPlaces).toBeLessThanOrEqual(1);
  });

  test('should handle coordinates at equator', () => {
    const lat1 = 0;
    const lon1 = 0;
    const lat2 = 0;
    const lon2 = 1;

    const distance = geospatialService.calculateDistance(lat1, lon1, lat2, lon2);

    // 1 degree at equator is approximately 111 km
    expect(distance).toBeGreaterThan(100);
    expect(distance).toBeLessThan(120);
  });

  test('should handle coordinates at poles', () => {
    const lat1 = 89;
    const lon1 = 0;
    const lat2 = 89;
    const lon2 = 180;

    const distance = geospatialService.calculateDistance(lat1, lon1, lat2, lon2);

    // At high latitudes, longitude differences result in smaller distances
    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThan(500);
  });
});

describe('GeospatialService - Satellite Image Fetching (Mapbox)', () => {
  test('should return null when MAPBOX_ACCESS_TOKEN is not set', async () => {
    const originalToken = process.env.MAPBOX_ACCESS_TOKEN;
    delete process.env.MAPBOX_ACCESS_TOKEN;

    const result = await geospatialService.fetchSatelliteImageUrl(28.7041, 77.1025, 16);
    expect(result).toBeNull();

    // Restore
    if (originalToken !== undefined) {
      process.env.MAPBOX_ACCESS_TOKEN = originalToken;
    }
  });

  test('should return null for invalid coordinates (NaN)', async () => {
    const result = await geospatialService.fetchSatelliteImageUrl(NaN, NaN, 16);
    expect(result).toBeNull();
  });

  test('should return null for null coordinates', async () => {
    const result = await geospatialService.fetchSatelliteImageUrl(null, null, 16);
    expect(result).toBeNull();
  });

  test('should return null for undefined coordinates', async () => {
    const result = await geospatialService.fetchSatelliteImageUrl(undefined, undefined, 16);
    expect(result).toBeNull();
  });
});
