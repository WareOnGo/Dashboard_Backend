const JWTService = require('../services/jwtService');

/**
 * Authentication middleware for protecting routes with JWT validation
 * Validates JWT tokens and adds user context to requests
 */
class AuthMiddleware {
    constructor() {
        this.jwtService = new JWTService();
    }

    /**
     * Main authentication middleware function
     * Validates JWT token from Authorization header and adds user to request
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     * @param {Function} next - Express next function
     */
    authenticateJWT = (req, res, next) => {
        try {
            // Extract token from Authorization header
            const token = this.extractTokenFromHeader(req);

            if (!token) {
                return this.sendUnauthorizedResponse(res, 'No authentication token provided');
            }

            // Verify token and get user payload
            const userPayload = this.jwtService.verifyToken(token);

            // Add user context to request object
            req.user = {
                id: userPayload.id,
                email: userPayload.email,
                name: userPayload.name,
                picture: userPayload.picture,
                domain: userPayload.domain,
                isAuthenticated: true
            };

            // Add token info for potential refresh
            req.tokenInfo = {
                token: token,
                issuedAt: userPayload.iat,
                expiresAt: userPayload.exp
            };

            next();
        } catch (error) {
            return this.handleAuthenticationError(error, res);
        }
    };

    /**
     * Optional authentication middleware - doesn't fail if no token
     * Adds user context if valid token is present, otherwise continues
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     * @param {Function} next - Express next function
     */
    optionalAuthentication = (req, res, next) => {
        try {
            const token = this.extractTokenFromHeader(req);

            if (!token) {
                // No token provided, continue without authentication
                req.user = null;
                return next();
            }

            // Try to verify token
            const userPayload = this.jwtService.verifyToken(token);

            // Add user context to request object
            req.user = {
                id: userPayload.id,
                email: userPayload.email,
                name: userPayload.name,
                picture: userPayload.picture,
                domain: userPayload.domain,
                isAuthenticated: true
            };

            req.tokenInfo = {
                token: token,
                issuedAt: userPayload.iat,
                expiresAt: userPayload.exp
            };

            next();
        } catch (error) {
            // Token is invalid, but continue without authentication
            req.user = null;
            next();
        }
    };

    /**
     * Middleware to check if user has specific domain access
     * Must be used after authenticateJWT middleware
     * @param {string} requiredDomain - Required email domain
     * @returns {Function} Middleware function
     */
    requireDomain = (requiredDomain) => {
        return (req, res, next) => {
            if (!req.user || !req.user.isAuthenticated) {
                return this.sendUnauthorizedResponse(res, 'Authentication required');
            }

            if (req.user.domain !== requiredDomain) {
                return this.sendForbiddenResponse(res, `Access restricted to ${requiredDomain} domain`);
            }

            next();
        };
    };

    /**
     * Middleware to check token expiration and suggest refresh
     * @param {number} refreshThresholdMinutes - Minutes before expiration to suggest refresh
     * @returns {Function} Middleware function
     */
    checkTokenExpiration = (refreshThresholdMinutes = 60) => {
        return (req, res, next) => {
            if (!req.tokenInfo) {
                return next();
            }

            const currentTime = Math.floor(Date.now() / 1000);
            const timeUntilExpiration = req.tokenInfo.expiresAt - currentTime;
            const thresholdSeconds = refreshThresholdMinutes * 60;

            // Add refresh suggestion to response headers if token is expiring soon
            if (timeUntilExpiration <= thresholdSeconds && timeUntilExpiration > 0) {
                res.set('X-Token-Refresh-Suggested', 'true');
                res.set('X-Token-Expires-In', timeUntilExpiration.toString());
            }

            next();
        };
    };

    /**
     * Extract JWT token from Authorization header
     * @param {Object} req - Express request object
     * @returns {string|null} JWT token or null if not found
     */
    extractTokenFromHeader(req) {
        const authHeader = req.headers.authorization;

        if (!authHeader) {
            return null;
        }

        // Check for Bearer token format
        if (authHeader.startsWith('Bearer ')) {
            return authHeader.slice(7); // Remove 'Bearer ' prefix
        }

        // Check for direct token (fallback)
        if (authHeader && !authHeader.includes(' ')) {
            return authHeader;
        }

        return null;
    }

    /**
     * Handle authentication errors and send appropriate responses
     * @param {Error} error - Authentication error
     * @param {Object} res - Express response object
     */
    handleAuthenticationError(error, res) {
        console.error('Authentication middleware error:', {
            message: error.message,
            code: error.code,
            statusCode: error.statusCode,
            timestamp: new Date().toISOString(),
            originalError: error.originalError
        });

        // Handle specific error types with structured responses
        switch (error.code) {
            case 'TOKEN_EXPIRED':
                return this.sendUnauthorizedResponse(res, 
                    'Your session has expired. Please sign in again.', 
                    'TOKEN_EXPIRED'
                );

            case 'INVALID_TOKEN':
            case 'INVALID_TOKEN_FORMAT':
            case 'INVALID_TOKEN_PAYLOAD':
                return this.sendUnauthorizedResponse(res, 
                    'Invalid authentication token. Please sign in again.', 
                    'INVALID_TOKEN'
                );

            case 'EMPTY_TOKEN':
                return this.sendUnauthorizedResponse(res, 
                    'Authentication token is required.', 
                    'MISSING_TOKEN'
                );

            case 'INVALID_DOMAIN':
                return this.sendForbiddenResponse(res, 
                    'Access restricted to authorized domains.', 
                    'DOMAIN_RESTRICTED'
                );

            case 'TOKEN_NOT_ACTIVE':
                return this.sendUnauthorizedResponse(res, 
                    'Authentication token is not yet valid.', 
                    'TOKEN_NOT_ACTIVE'
                );

            default:
                // Generic authentication error
                const statusCode = error.statusCode || 401;
                const message = statusCode >= 500 
                    ? 'Authentication service error. Please try again.'
                    : error.message || 'Authentication failed';
                
                return this.sendUnauthorizedResponse(res, message, 'AUTH_FAILED');
        }
    }

    /**
     * Send 401 Unauthorized response
     * @param {Object} res - Express response object
     * @param {string} message - Error message
     * @param {string} code - Error code
     */
    sendUnauthorizedResponse(res, message, code = 'UNAUTHORIZED') {
        return res.status(401).json({
            error: message,
            code: code,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Send 403 Forbidden response
     * @param {Object} res - Express response object
     * @param {string} message - Error message
     * @param {string} code - Error code
     */
    sendForbiddenResponse(res, message, code = 'FORBIDDEN') {
        return res.status(403).json({
            error: message,
            code: code,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Create middleware instance for use in routes
     * @returns {Object} Middleware functions
     */
    static create() {
        const instance = new AuthMiddleware();
        return {
            authenticateJWT: instance.authenticateJWT,
            optionalAuthentication: instance.optionalAuthentication,
            requireDomain: instance.requireDomain,
            checkTokenExpiration: instance.checkTokenExpiration
        };
    }
}

// Export both class and convenience instance
module.exports = AuthMiddleware;
module.exports.authMiddleware = AuthMiddleware.create();