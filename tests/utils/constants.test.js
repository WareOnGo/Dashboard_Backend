const {
  HTTP_STATUS,
  ERROR_TYPES,
  PRISMA_ERROR_CODES,
  PAGINATION,
  FILE_UPLOAD,
  ENVIRONMENT
} = require('../../src/utils/constants');

describe('Constants', () => {
  describe('HTTP_STATUS', () => {
    it('should have correct status codes', () => {
      expect(HTTP_STATUS.OK).toBe(200);
      expect(HTTP_STATUS.CREATED).toBe(201);
      expect(HTTP_STATUS.BAD_REQUEST).toBe(400);
      expect(HTTP_STATUS.NOT_FOUND).toBe(404);
      expect(HTTP_STATUS.INTERNAL_SERVER_ERROR).toBe(500);
    });
  });

  describe('ERROR_TYPES', () => {
    it('should have defined error types', () => {
      expect(ERROR_TYPES.VALIDATION_ERROR).toBe('ValidationError');
      expect(ERROR_TYPES.DATABASE_ERROR).toBe('DatabaseError');
      expect(ERROR_TYPES.NOT_FOUND_ERROR).toBe('NotFoundError');
    });
  });

  describe('PAGINATION', () => {
    it('should have correct default values', () => {
      expect(PAGINATION.DEFAULT_PAGE).toBe(1);
      expect(PAGINATION.DEFAULT_LIMIT).toBe(10);
      expect(PAGINATION.MAX_LIMIT).toBe(100);
    });
  });

  describe('FILE_UPLOAD', () => {
    it('should have correct file upload settings', () => {
      expect(FILE_UPLOAD.MAX_FILE_SIZE).toBe(10 * 1024 * 1024);
      expect(FILE_UPLOAD.ALLOWED_MIME_TYPES).toContain('image/jpeg');
      expect(FILE_UPLOAD.PRESIGNED_URL_EXPIRY).toBe(360);
    });
  });

  describe('ENVIRONMENT', () => {
    it('should have environment constants', () => {
      expect(ENVIRONMENT.DEVELOPMENT).toBe('development');
      expect(ENVIRONMENT.PRODUCTION).toBe('production');
      expect(ENVIRONMENT.TEST).toBe('test');
    });
  });
});