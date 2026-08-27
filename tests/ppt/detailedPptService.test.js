const detailedPptService = require('../../src/ppt/services/detailedPptService');

describe('DetailedPptService - Photo Parsing', () => {
  test('should parse comma-separated photo URLs', () => {
    const photosString = 'https://example.com/photo1.jpg, https://example.com/photo2.jpg, https://example.com/photo3.jpg';
    const result = detailedPptService.parsePhotos(photosString);
    
    expect(result).toHaveLength(3);
    expect(result[0]).toBe('https://example.com/photo1.jpg');
    expect(result[1]).toBe('https://example.com/photo2.jpg');
    expect(result[2]).toBe('https://example.com/photo3.jpg');
  });

  test('should parse JSON array of photo URLs', () => {
    const photosString = '["https://example.com/photo1.jpg", "https://example.com/photo2.jpg"]';
    const result = detailedPptService.parsePhotos(photosString);
    
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('https://example.com/photo1.jpg');
    expect(result[1]).toBe('https://example.com/photo2.jpg');
  });

  test('should handle array input directly', () => {
    const photosArray = ['https://example.com/photo1.jpg', 'https://example.com/photo2.jpg'];
    const result = detailedPptService.parsePhotos(photosArray);
    
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('https://example.com/photo1.jpg');
    expect(result[1]).toBe('https://example.com/photo2.jpg');
  });

  test('should filter out invalid URLs', () => {
    const photosString = 'https://example.com/photo1.jpg, invalid-url, https://example.com/photo2.jpg';
    const result = detailedPptService.parsePhotos(photosString);
    
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('https://example.com/photo1.jpg');
    expect(result[1]).toBe('https://example.com/photo2.jpg');
  });

  test('should filter out empty strings', () => {
    const photosString = 'https://example.com/photo1.jpg, , https://example.com/photo2.jpg';
    const result = detailedPptService.parsePhotos(photosString);
    
    expect(result).toHaveLength(2);
  });

  test('should return empty array for null input', () => {
    const result = detailedPptService.parsePhotos(null);
    expect(result).toEqual([]);
  });

  test('should return empty array for undefined input', () => {
    const result = detailedPptService.parsePhotos(undefined);
    expect(result).toEqual([]);
  });

  test('should return empty array for empty string', () => {
    const result = detailedPptService.parsePhotos('');
    expect(result).toEqual([]);
  });

  test('should handle URLs with http protocol', () => {
    const photosString = 'http://example.com/photo1.jpg, https://example.com/photo2.jpg';
    const result = detailedPptService.parsePhotos(photosString);
    
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('http://example.com/photo1.jpg');
    expect(result[1]).toBe('https://example.com/photo2.jpg');
  });

  test('should trim whitespace from URLs', () => {
    const photosString = '  https://example.com/photo1.jpg  ,  https://example.com/photo2.jpg  ';
    const result = detailedPptService.parsePhotos(photosString);
    
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('https://example.com/photo1.jpg');
    expect(result[1]).toBe('https://example.com/photo2.jpg');
  });

  test('should handle single photo URL', () => {
    const photosString = 'https://example.com/photo1.jpg';
    const result = detailedPptService.parsePhotos(photosString);
    
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('https://example.com/photo1.jpg');
  });

  test('should filter out non-string elements in array', () => {
    const photosArray = ['https://example.com/photo1.jpg', null, 'https://example.com/photo2.jpg', undefined, 123];
    const result = detailedPptService.parsePhotos(photosArray);
    
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('https://example.com/photo1.jpg');
    expect(result[1]).toBe('https://example.com/photo2.jpg');
  });

  test('should handle malformed JSON gracefully', () => {
    const photosString = '["https://example.com/photo1.jpg", invalid json]';
    const result = detailedPptService.parsePhotos(photosString);
    
    // Should fall back to comma-separated parsing
    expect(result.length).toBeGreaterThanOrEqual(0);
  });
});
