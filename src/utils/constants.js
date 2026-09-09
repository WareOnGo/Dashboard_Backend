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

/**
 * Every media type a scout or dashboard user may upload, mapped to the file
 * extension used for its object key.
 *
 * This is the single source of truth for upload types. It previously lived in
 * four places that had drifted apart — this constant, the Zod contentType
 * refinement, the service's business-rule allowlist, and the service's
 * extension map — so the Scout form offered HEIC photos and Office documents
 * that the API then rejected. Add a type here and every layer picks it up.
 *
 * An entry with no extension would produce an extensionless object key, which
 * breaks how R2 serves the file back, so every type carries one.
 */
const MEDIA_TYPE_EXTENSIONS = {
    // Images
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    // Phone cameras (iOS, and some Android) capture these natively.
    'image/heic': '.heic',
    'image/heif': '.heif',
    // Videos
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/x-msvideo': '.avi',
    'video/x-matroska': '.mkv',
    'video/webm': '.webm',
    // Documents
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx'
};

// File Upload Constants
const FILE_UPLOAD = {
    MAX_FILE_SIZE: 10 * 1024 * 1024, // 10MB
    MEDIA_TYPE_EXTENSIONS,
    ALLOWED_MIME_TYPES: Object.keys(MEDIA_TYPE_EXTENSIONS),
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