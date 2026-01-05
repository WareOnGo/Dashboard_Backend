const jwt = require('jsonwebtoken');
const BaseService = require('./baseService');
const { getAuthConfig } = require('../utils/config');

/**
 * JWT Service for token generation, validation, and refresh operations
 * Handles secure JWT token management for authentication
 */
class JWTService extends BaseService {
    constructor() {
        super();
        this.config = getAuthConfig();
    }

    /**
     * Generate a JWT token with user payload
     * @param {Object} payload - User data to encode in token
     * @param {string} [expiresIn] - Token expiration time (default from config)
     * @returns {string} Generated JWT token
     * @throws {Error} If token generation fails
     */
    generateToken(payload, expiresIn = null) {
        try {
            // Validate payload
            if (!payload || typeof payload !== 'object') {
                const error = new Error('Token payload must be a valid object');
                error.code = 'INVALID_PAYLOAD';
                error.statusCode = 400;
                throw error;
            }

            // Ensure required fields are present
            if (!payload.id || !payload.email) {
                const error = new Error('Token payload must include id and email');
                error.code = 'MISSING_REQUIRED_FIELDS';
                error.statusCode = 400;
                throw error;
            }

            // Validate email domain
            if (!this.validateEmailDomain(payload.email)) {
                const error = new Error('Invalid email domain for token generation');
                error.code = 'INVALID_DOMAIN';
                error.statusCode = 403;
                throw error;
            }

            // Prepare token payload with standard claims
            const tokenPayload = {
                id: payload.id,
                email: payload.email,
                name: payload.name,
                picture: payload.picture,
                domain: this.extractDomain(payload.email),
                iss: 'warehouse-api', // Issuer
                aud: 'warehouse-frontend' // Audience
            };

            // Generate token with expiration
            const options = {
                expiresIn: expiresIn || this.config.jwt.expiresIn,
                algorithm: 'HS256'
            };

            let token;
            try {
                token = jwt.sign(tokenPayload, this.config.jwt.secret, options);
            } catch (jwtError) {
                const error = new Error('Failed to sign JWT token');
                error.code = 'TOKEN_SIGNING_ERROR';
                error.statusCode = 500;
                error.originalError = jwtError.message;
                throw error;
            }
            
            return token;
        } catch (error) {
            // Ensure error has proper structure
            if (!error.code) {
                error.code = 'TOKEN_GENERATION_ERROR';
            }
            if (!error.statusCode) {
                error.statusCode = 500;
            }
            
            this.handleError(error);
        }
    }

    /**
     * Verify and decode a JWT token
     * @param {string} token - JWT token to verify
     * @returns {Object} Decoded token payload
     * @throws {Error} If token is invalid or expired
     */
    verifyToken(token) {
        try {
            if (!token || typeof token !== 'string') {
                const error = new Error('Token must be a valid string');
                error.code = 'INVALID_TOKEN_FORMAT';
                error.statusCode = 400;
                throw error;
            }

            // Remove 'Bearer ' prefix if present
            const cleanToken = token.startsWith('Bearer ') ? token.slice(7) : token;

            if (!cleanToken.trim()) {
                const error = new Error('Token cannot be empty');
                error.code = 'EMPTY_TOKEN';
                error.statusCode = 400;
                throw error;
            }

            // Verify token signature and expiration
            let decoded;
            try {
                decoded = jwt.verify(cleanToken, this.config.jwt.secret, {
                    algorithms: ['HS256'],
                    audience: 'warehouse-frontend',
                    issuer: 'warehouse-api'
                });
            } catch (jwtError) {
                const error = new Error(this.getJWTErrorMessage(jwtError));
                error.code = this.getJWTErrorCode(jwtError);
                error.statusCode = error.code === 'TOKEN_EXPIRED' ? 401 : 400;
                error.originalError = jwtError.message;
                throw error;
            }

            // Additional validation
            if (!decoded.id || !decoded.email) {
                const error = new Error('Token payload is missing required fields');
                error.code = 'INVALID_TOKEN_PAYLOAD';
                error.statusCode = 400;
                throw error;
            }

            // Validate email domain
            if (!this.validateEmailDomain(decoded.email)) {
                const error = new Error('Token contains invalid email domain');
                error.code = 'INVALID_DOMAIN';
                error.statusCode = 403;
                throw error;
            }

            return decoded;
        } catch (error) {
            // Ensure error has proper structure
            if (!error.code) {
                error.code = 'TOKEN_VERIFICATION_ERROR';
            }
            if (!error.statusCode) {
                error.statusCode = 400;
            }
            
            this.handleError(error);
        }
    }

    /**
     * Get user-friendly JWT error message
     * @param {Error} jwtError - JWT library error
     * @returns {string} User-friendly error message
     */
    getJWTErrorMessage(jwtError) {
        switch (jwtError.name) {
            case 'TokenExpiredError':
                return 'Your session has expired. Please sign in again.';
            case 'JsonWebTokenError':
                return 'Invalid authentication token. Please sign in again.';
            case 'NotBeforeError':
                return 'Authentication token is not yet valid.';
            default:
                return 'Authentication token verification failed.';
        }
    }

    /**
     * Get structured error code from JWT error
     * @param {Error} jwtError - JWT library error
     * @returns {string} Error code
     */
    getJWTErrorCode(jwtError) {
        switch (jwtError.name) {
            case 'TokenExpiredError':
                return 'TOKEN_EXPIRED';
            case 'JsonWebTokenError':
                return 'INVALID_TOKEN';
            case 'NotBeforeError':
                return 'TOKEN_NOT_ACTIVE';
            default:
                return 'TOKEN_VERIFICATION_ERROR';
        }
    }

    /**
     * Refresh a JWT token by generating a new one with updated expiration
     * @param {string} token - Current JWT token
     * @returns {string} New JWT token
     * @throws {Error} If refresh fails
     */
    refreshToken(token) {
        try {
            // Verify current token (this will throw if invalid/expired)
            const decoded = this.verifyToken(token);

            // Remove JWT standard claims before regenerating
            const { iat, exp, iss, aud, ...userPayload } = decoded;

            // Generate new token with fresh expiration
            return this.generateToken(userPayload);
        } catch (error) {
            // Pass through structured errors from verifyToken and generateToken
            if (error.code && error.statusCode) {
                throw error;
            }
            
            // Wrap unstructured errors
            const wrappedError = new Error(`Token refresh failed: ${error.message}`);
            wrappedError.code = 'TOKEN_REFRESH_ERROR';
            wrappedError.statusCode = 400;
            wrappedError.originalError = error.message;
            
            this.handleError(wrappedError);
        }
    }

    /**
     * Decode token without verification (for debugging/inspection)
     * @param {string} token - JWT token to decode
     * @returns {Object} Decoded token payload (unverified)
     */
    decodeToken(token) {
        try {
            const cleanToken = token.startsWith('Bearer ') ? token.slice(7) : token;
            return jwt.decode(cleanToken);
        } catch (error) {
            throw new Error(`Token decode failed: ${error.message}`);
        }
    }

    /**
     * Check if a token is expired without full verification
     * @param {string} token - JWT token to check
     * @returns {boolean} True if token is expired
     */
    isTokenExpired(token) {
        try {
            const decoded = this.decodeToken(token);
            if (!decoded || !decoded.exp) {
                return true;
            }
            
            const currentTime = Math.floor(Date.now() / 1000);
            return decoded.exp < currentTime;
        } catch (error) {
            return true; // Consider invalid tokens as expired
        }
    }

    /**
     * Validate email domain against allowed domain
     * @param {string} email - Email to validate
     * @returns {boolean} True if domain is allowed
     */
    validateEmailDomain(email) {
        if (!email || typeof email !== 'string') {
            return false;
        }

        const domain = this.extractDomain(email);
        return domain.toLowerCase() === this.config.auth.allowedDomain.toLowerCase();
    }

    /**
     * Extract domain from email address
     * @param {string} email - Email address
     * @returns {string} Domain part of email
     */
    extractDomain(email) {
        if (!email || !email.includes('@')) {
            throw new Error('Invalid email format');
        }
        
        return email.split('@')[1];
    }

    /**
     * Get token expiration time in seconds
     * @returns {number} Token expiration time in seconds
     */
    getTokenExpirationTime() {
        const expiresIn = this.config.jwt.expiresIn;
        
        // Parse different time formats (24h, 1d, 3600s, etc.)
        if (typeof expiresIn === 'string') {
            const match = expiresIn.match(/^(\d+)([smhd])$/);
            if (match) {
                const value = parseInt(match[1]);
                const unit = match[2];
                
                switch (unit) {
                    case 's': return value;
                    case 'm': return value * 60;
                    case 'h': return value * 60 * 60;
                    case 'd': return value * 24 * 60 * 60;
                    default: return 24 * 60 * 60; // Default to 24 hours
                }
            }
        }
        
        return typeof expiresIn === 'number' ? expiresIn : 24 * 60 * 60;
    }
}

module.exports = JWTService;