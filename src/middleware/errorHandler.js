// src/middleware/errorHandler.js
const { Prisma } = require('@prisma/client');

/**
 * Centralized error handler middleware for the application
 * Handles Prisma errors, validation errors, and generic errors
 */
class ErrorHandler {
    /**
     * Main error handling middleware
     * @param {Error} error - The error object
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     * @param {Function} next - Express next function
     */
    static handle(error, req, res, next) {
        // Log error for debugging
        console.error('Error occurred:', {
            message: error.message,
            stack: error.stack,
            path: req.path,
            method: req.method,
            timestamp: new Date().toISOString()
        });

        // Handle Prisma errors
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
            return ErrorHandler.handlePrismaError(error, req, res);
        }

        // Handle Prisma validation errors
        if (error instanceof Prisma.PrismaClientValidationError) {
            return ErrorHandler.handlePrismaValidationError(error, req, res);
        }

        // Handle validation errors (from Zod or custom validators)
        if (error.name === 'ValidationError') {
            return ErrorHandler.handleValidationError(error, req, res);
        }

        // Handle generic errors
        return ErrorHandler.handleGenericError(error, req, res);
    }

    /**
     * Handle Prisma database errors
     * @param {Prisma.PrismaClientKnownRequestError} error - Prisma error
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     */
    static handlePrismaError(error, req, res) {
        const errorResponse = ErrorHandler.createErrorResponse(
            ErrorHandler.getPrismaErrorMessage(error.code),
            error.code,
            req.path
        );

        const statusCode = ErrorHandler.getPrismaErrorStatusCode(error.code);
        return res.status(statusCode).json(errorResponse);
    }

    /**
     * Handle Prisma validation errors
     * @param {Prisma.PrismaClientValidationError} error - Prisma validation error
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     */
    static handlePrismaValidationError(error, req, res) {
        const errorResponse = ErrorHandler.createErrorResponse(
            'Invalid data provided to database operation',
            'PRISMA_VALIDATION_ERROR',
            req.path,
            { originalError: error.message }
        );

        return res.status(400).json(errorResponse);
    }

    /**
     * Handle validation errors (from Zod or custom validators)
     * @param {Error} error - Validation error
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     */
    static handleValidationError(error, req, res) {
        const errorResponse = ErrorHandler.createErrorResponse(
            'Validation failed',
            'VALIDATION_ERROR',
            req.path,
            { issues: error.issues || [] }
        );

        return res.status(400).json(errorResponse);
    }

    /**
     * Handle generic errors
     * @param {Error} error - Generic error
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     */
    static handleGenericError(error, req, res) {
        const errorResponse = ErrorHandler.createErrorResponse(
            'Internal server error',
            'INTERNAL_ERROR',
            req.path
        );

        return res.status(500).json(errorResponse);
    }

    /**
     * Create standardized error response
     * @param {string} message - Error message
     * @param {string} code - Error code
     * @param {string} path - Request path
     * @param {Object} details - Additional error details
     * @returns {Object} Standardized error response
     */
    static createErrorResponse(message, code, path, details = null) {
        const errorResponse = {
            error: message,
            code: code,
            timestamp: new Date().toISOString(),
            path: path
        };

        if (details) {
            errorResponse.details = details;
        }

        return errorResponse;
    }

    /**
     * Get human-readable message for Prisma error codes
     * @param {string} code - Prisma error code
     * @returns {string} Human-readable error message
     */
    static getPrismaErrorMessage(code) {
        const errorMessages = {
            'P2000': 'The provided value is too long for the column',
            'P2001': 'The record searched for does not exist',
            'P2002': 'Unique constraint failed',
            'P2003': 'Foreign key constraint failed',
            'P2004': 'A constraint failed on the database',
            'P2005': 'The value stored in the database is invalid for the field type',
            'P2006': 'The provided value is not valid for the field',
            'P2007': 'Data validation error',
            'P2008': 'Failed to parse the query',
            'P2009': 'Failed to validate the query',
            'P2010': 'Raw query failed',
            'P2011': 'Null constraint violation',
            'P2012': 'Missing a required value',
            'P2013': 'Missing the required argument',
            'P2014': 'The change would violate the required relation',
            'P2015': 'A related record could not be found',
            'P2016': 'Query interpretation error',
            'P2017': 'The records for relation are not connected',
            'P2018': 'The required connected records were not found',
            'P2019': 'Input error',
            'P2020': 'Value out of range for the type',
            'P2021': 'The table does not exist in the current database',
            'P2022': 'The column does not exist in the current database',
            'P2023': 'Inconsistent column data',
            'P2024': 'Timed out fetching a new connection from the connection pool',
            'P2025': 'Record not found',
            'P2026': 'The current database provider doesn\'t support a feature',
            'P2027': 'Multiple errors occurred on the database during query execution'
        };

        return errorMessages[code] || 'Database operation failed';
    }

    /**
     * Get appropriate HTTP status code for Prisma error codes
     * @param {string} code - Prisma error code
     * @returns {number} HTTP status code
     */
    static getPrismaErrorStatusCode(code) {
        const statusCodes = {
            'P2001': 404, // Record not found
            'P2002': 409, // Unique constraint failed
            'P2003': 400, // Foreign key constraint failed
            'P2004': 400, // Constraint failed
            'P2005': 400, // Invalid value for field type
            'P2006': 400, // Invalid value for field
            'P2007': 400, // Data validation error
            'P2011': 400, // Null constraint violation
            'P2012': 400, // Missing required value
            'P2013': 400, // Missing required argument
            'P2014': 400, // Relation violation
            'P2015': 404, // Related record not found
            'P2018': 404, // Required connected records not found
            'P2019': 400, // Input error
            'P2020': 400, // Value out of range
            'P2025': 404, // Record not found
            'P2024': 503, // Connection timeout
            'P2026': 501  // Feature not supported
        };

        return statusCodes[code] || 500;
    }

    /**
     * Create a 404 Not Found error
     * @param {string} resource - The resource that was not found
     * @returns {Error} Not found error
     */
    static createNotFoundError(resource) {
        const error = new Error(`${resource} not found`);
        error.name = 'NotFoundError';
        error.statusCode = 404;
        return error;
    }

    /**
     * Create a validation error
     * @param {string} message - Error message
     * @param {Array} issues - Validation issues
     * @returns {Error} Validation error
     */
    static createValidationError(message, issues = []) {
        const error = new Error(message);
        error.name = 'ValidationError';
        error.issues = issues;
        error.statusCode = 400;
        return error;
    }

    /**
     * Create a conflict error
     * @param {string} message - Error message
     * @returns {Error} Conflict error
     */
    static createConflictError(message) {
        const error = new Error(message);
        error.name = 'ConflictError';
        error.statusCode = 409;
        return error;
    }
}

module.exports = ErrorHandler;