const ErrorHandler = require('../../src/middleware/errorHandler');
const { Prisma } = require('@prisma/client');

describe('ErrorHandler', () => {
  let req, res, next;

  beforeEach(() => {
    req = {
      path: '/test',
      method: 'GET'
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    next = jest.fn();
    
    // Mock console.error to avoid noise in tests
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('handle', () => {
    it('should handle Prisma known request errors', () => {
      const error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        { code: 'P2002', clientVersion: '4.0.0' }
      );

      ErrorHandler.handle(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Unique constraint failed',
        code: 'P2002',
        timestamp: expect.any(String),
        path: '/test'
      });
    });

    it('should handle Prisma validation errors', () => {
      const error = new Prisma.PrismaClientValidationError(
        'Invalid data provided',
        { clientVersion: '4.0.0' }
      );

      ErrorHandler.handle(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Invalid data provided to database operation',
        code: 'PRISMA_VALIDATION_ERROR',
        timestamp: expect.any(String),
        path: '/test',
        details: { originalError: 'Invalid data provided' }
      });
    });

    it('should handle validation errors', () => {
      const error = new Error('Validation failed');
      error.name = 'ValidationError';
      error.issues = [{ field: 'name', message: 'Required' }];

      ErrorHandler.handle(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        timestamp: expect.any(String),
        path: '/test',
        details: { issues: [{ field: 'name', message: 'Required' }] }
      });
    });

    it('should handle generic errors', () => {
      const error = new Error('Something went wrong');

      ErrorHandler.handle(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
        timestamp: expect.any(String),
        path: '/test'
      });
    });
  });

  describe('getPrismaErrorMessage', () => {
    it('should return correct message for known error codes', () => {
      expect(ErrorHandler.getPrismaErrorMessage('P2002')).toBe('Unique constraint failed');
      expect(ErrorHandler.getPrismaErrorMessage('P2025')).toBe('Record not found');
      expect(ErrorHandler.getPrismaErrorMessage('P2001')).toBe('The record searched for does not exist');
    });

    it('should return default message for unknown error codes', () => {
      expect(ErrorHandler.getPrismaErrorMessage('P9999')).toBe('Database operation failed');
    });
  });

  describe('getPrismaErrorStatusCode', () => {
    it('should return correct status codes for known error codes', () => {
      expect(ErrorHandler.getPrismaErrorStatusCode('P2002')).toBe(409);
      expect(ErrorHandler.getPrismaErrorStatusCode('P2025')).toBe(404);
      expect(ErrorHandler.getPrismaErrorStatusCode('P2001')).toBe(404);
      expect(ErrorHandler.getPrismaErrorStatusCode('P2012')).toBe(400);
    });

    it('should return 500 for unknown error codes', () => {
      expect(ErrorHandler.getPrismaErrorStatusCode('P9999')).toBe(500);
    });
  });

  describe('createNotFoundError', () => {
    it('should create a not found error', () => {
      const error = ErrorHandler.createNotFoundError('User');
      
      expect(error.message).toBe('User not found');
      expect(error.name).toBe('NotFoundError');
      expect(error.statusCode).toBe(404);
    });
  });

  describe('createValidationError', () => {
    it('should create a validation error', () => {
      const issues = [{ field: 'email', message: 'Invalid email' }];
      const error = ErrorHandler.createValidationError('Validation failed', issues);
      
      expect(error.message).toBe('Validation failed');
      expect(error.name).toBe('ValidationError');
      expect(error.issues).toEqual(issues);
      expect(error.statusCode).toBe(400);
    });
  });

  describe('createConflictError', () => {
    it('should create a conflict error', () => {
      const error = ErrorHandler.createConflictError('Resource already exists');
      
      expect(error.message).toBe('Resource already exists');
      expect(error.name).toBe('ConflictError');
      expect(error.statusCode).toBe(409);
    });
  });
});