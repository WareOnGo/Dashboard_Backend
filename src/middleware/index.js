// src/middleware/index.js
/**
 * Middleware exports for easy importing
 */

const ErrorHandler = require('./errorHandler');
const ValidationMiddleware = require('./validation');
const AuthMiddleware = require('./authMiddleware');
const createAuditMiddleware = require('./auditMiddleware');

module.exports = {
    ErrorHandler,
    ValidationMiddleware,
    AuthMiddleware,
    createAuditMiddleware,
    // Convenience exports for common auth middleware functions
    authMiddleware: AuthMiddleware.authMiddleware
};