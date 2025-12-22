// src/utils/constants.js

/**
 * Application constants and configuration values
 */

// HTTP Status Codes
const HTTP_STATUS = {
    OK: 200,
    CREATED: 201,
    NO_CONTENT: 204,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    UNPROCESSABLE_ENTITY: 422,
    INTERNAL_SERVER_ERROR: 500,
    SERVICE_UNAVAILABLE: 503
};

// Error Types
const ERROR_TYPES = {
    VALIDATION_ERROR: 'ValidationError',
    DATABASE_ERROR: 'DatabaseError',
    NOT_FOUND_ERROR: 'NotFoundError',
    BUSINESS_LOGIC_ERROR: 'BusinessLogicError',
    AUTHENTICATION_ERROR: 'AuthenticationError',
    AUTHORIZATION_ERROR: 'AuthorizationError'
};

// Prisma Error Codes
const PRISMA_ERROR_CODES = {
    UNIQUE_CONSTRAINT_VIOLATION: 'P2002',
    RECORD_NOT_FOUND: 'P2025',
    FOREIGN_KEY_CONSTRAINT_VIOLATION: 'P2003',
    REQUIRED_FIELD_MISSING: 'P2012',
    CONNECTION_ERROR: 'P1001',
    DATABASE_NOT_FOUND: 'P1003'
};

// Default Pagination
const PAGINATION = {
    DEFAULT_PAGE: 1,
    DEFAULT_LIMIT: 10,
    MAX_LIMIT: 100
};

// File Upload Constants
const FILE_UPLOAD = {
    MAX_FILE_SIZE: 10 * 1024 * 1024, // 10MB
    ALLOWED_MIME_TYPES: [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'application/pdf'
    ],
    PRESIGNED_URL_EXPIRY: 360 // seconds
};

// Environment
const ENVIRONMENT = {
    DEVELOPMENT: 'development',
    PRODUCTION: 'production',
    TEST: 'test'
};

module.exports = {
    HTTP_STATUS,
    ERROR_TYPES,
    PRISMA_ERROR_CODES,
    PAGINATION,
    FILE_UPLOAD,
    ENVIRONMENT
};