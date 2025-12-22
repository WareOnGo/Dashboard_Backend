// src/controllers/baseController.js
/**
 * Base controller class providing common HTTP utilities and response formatting
 */
class BaseController {
    /**
     * Send a successful response with data
     * @param {Object} res - Express response object
     * @param {*} data - Data to send in response
     * @param {number} statusCode - HTTP status code (default: 200)
     */
    sendSuccess(res, data, statusCode = 200) {
        return res.status(statusCode).json(data);
    }

    /**
     * Send a successful response for creation
     * @param {Object} res - Express response object
     * @param {*} data - Created resource data
     */
    sendCreated(res, data) {
        return this.sendSuccess(res, data, 201);
    }

    /**
     * Send a successful response with no content
     * @param {Object} res - Express response object
     */
    sendNoContent(res) {
        return res.status(204).send();
    }

    /**
     * Send an error response
     * @param {Object} res - Express response object
     * @param {string} message - Error message
     * @param {number} statusCode - HTTP status code (default: 500)
     * @param {Object} details - Additional error details
     */
    sendError(res, message, statusCode = 500, details = null) {
        const errorResponse = {
            error: message,
            timestamp: new Date().toISOString(),
            path: res.req.path
        };

        if (details) {
            errorResponse.details = details;
        }

        return res.status(statusCode).json(errorResponse);
    }

    /**
     * Send a validation error response
     * @param {Object} res - Express response object
     * @param {Array} issues - Validation issues
     */
    sendValidationError(res, issues) {
        return this.sendError(res, 'Invalid input', 400, { issues });
    }

    /**
     * Send a not found error response
     * @param {Object} res - Express response object
     * @param {string} resource - Resource name
     * @param {string|number} id - Resource ID
     */
    sendNotFound(res, resource, id) {
        return this.sendError(res, `${resource} with ID ${id} not found`, 404);
    }

    /**
     * Async wrapper for controller methods to handle errors
     * @param {Function} fn - Controller method
     * @returns {Function} Wrapped controller method
     */
    asyncHandler(fn) {
        return (req, res, next) => {
            Promise.resolve(fn(req, res, next)).catch(next);
        };
    }

    /**
     * Extract and validate ID parameter from request
     * @param {Object} req - Express request object
     * @param {string} paramName - Parameter name (default: 'id')
     * @returns {number} Parsed ID
     * @throws {Error} If ID is invalid
     */
    extractId(req, paramName = 'id') {
        const id = parseInt(req.params[paramName]);
        if (isNaN(id) || id <= 0) {
            throw new Error(`Invalid ${paramName} parameter`);
        }
        return id;
    }
}

module.exports = BaseController;