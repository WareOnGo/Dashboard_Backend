// src/middleware/index.js
/**
 * Middleware exports for easy importing
 */

const ErrorHandler = require('./errorHandler');
const ValidationMiddleware = require('./validation');

module.exports = {
    ErrorHandler,
    ValidationMiddleware,
    // Future middleware exports
    // cors: require('./cors')
};