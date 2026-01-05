// src/middleware/index.js
/**
 * Middleware exports for easy importing
 */

const ErrorHandler = require('./errorHandler');
const ValidationMiddleware = require('./validation');
const AuthMiddleware = require('./authMiddleware');

module.exports = {
    ErrorHandler,
    ValidationMiddleware,
    AuthMiddleware,
    // Convenience exports for common auth middleware functions
    authMiddleware: AuthMiddleware.authMiddleware
};