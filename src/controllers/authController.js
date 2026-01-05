const BaseController = require('./baseController');
const GoogleOAuthService = require('../services/googleOAuthService');
const JWTService = require('../services/jwtService');

/**
 * Authentication Controller
 * Handles OAuth callback, token refresh, logout, and user info endpoints
 */
class AuthController extends BaseController {
    constructor() {
        super();
        this.googleOAuthService = new GoogleOAuthService();
        this.jwtService = new JWTService();
    }

    /**
     * Handle Google OAuth callback
     * Process authorization code and generate JWT token
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     */
    handleOAuthCallback = async (req, res) => {
        try {
            const { code, error, error_description, state } = req.query;

            // Handle OAuth errors from Google
            if (error) {
                const errorMessage = this.getOAuthErrorMessage(error, error_description);
                // Redirect to frontend with error
                const { config } = require('../utils/config');
                const frontendUrl = config.server.frontendUrl;
                return res.redirect(`${frontendUrl}/?error=${encodeURIComponent(errorMessage)}`);
            }

            // Validate authorization code
            if (!code) {
                const { config } = require('../utils/config');
                const frontendUrl = config.server.frontendUrl;
                return res.redirect(`${frontendUrl}/?error=${encodeURIComponent('Authorization code is required')}`);
            }

            // Complete OAuth flow
            const oauthResult = await this.googleOAuthService.completeOAuthFlow(code);

            // Generate JWT token
            const jwtToken = this.jwtService.generateToken(oauthResult.user);

            // Prepare user data
            const userData = {
                id: oauthResult.user.id,
                email: oauthResult.user.email,
                name: oauthResult.user.name,
                picture: oauthResult.user.picture,
                domain: this.jwtService.extractDomain(oauthResult.user.email)
            };

            // Redirect to frontend with token and user data
            const { config } = require('../utils/config');
            const frontendUrl = config.server.frontendUrl;
            const redirectUrl = `${frontendUrl}/auth/callback?token=${encodeURIComponent(jwtToken)}&user=${encodeURIComponent(JSON.stringify(userData))}`;

            return res.redirect(redirectUrl);

        } catch (error) {
            // Redirect to frontend with error
            const { config } = require('../utils/config');
            const frontendUrl = config.server.frontendUrl;
            const errorMessage = error.message || 'Authentication failed';
            return res.redirect(`${frontendUrl}/?error=${encodeURIComponent(errorMessage)}`);
        }
    };

    /**
     * Handle authentication errors with specific error types
     * @param {Error} error - The error object
     * @param {Object} res - Express response object
     * @param {string} context - Context where error occurred
     */
    handleAuthenticationError(error, res, context = 'Authentication') {
        // Log error for monitoring
        console.error(`${context} error:`, {
            message: error.message,
            code: error.code,
            statusCode: error.statusCode,
            timestamp: new Date().toISOString(),
            originalError: error.originalError
        });

        // Handle specific error types
        switch (error.code) {
            case 'DOMAIN_RESTRICTED':
                return this.sendError(res,
                    `Access restricted to @${error.allowedDomain} accounts. Your account uses @${error.userDomain}.`,
                    403,
                    {
                        error_type: 'domain_restricted',
                        allowed_domain: error.allowedDomain,
                        user_domain: error.userDomain
                    }
                );

            case 'INVALID_AUTH_CODE':
                return this.sendError(res,
                    'The authorization code is invalid or has expired. Please try signing in again.',
                    400,
                    { error_type: 'invalid_auth_code' }
                );

            case 'OAUTH_SERVICE_UNAVAILABLE':
            case 'GOOGLE_API_UNAVAILABLE':
                return this.sendError(res,
                    'Authentication service is temporarily unavailable. Please try again in a few moments.',
                    503,
                    {
                        error_type: 'service_unavailable',
                        retry_after: 30
                    }
                );

            case 'OAUTH_CONFIG_ERROR':
                return this.sendError(res,
                    'Authentication service configuration error. Please contact support.',
                    500,
                    { error_type: 'configuration_error' }
                );

            case 'TOKEN_EXPIRED':
                return this.sendError(res,
                    'Your session has expired. Please sign in again.',
                    401,
                    { error_type: 'token_expired' }
                );

            case 'INVALID_TOKEN':
                return this.sendError(res,
                    'Invalid authentication token. Please sign in again.',
                    401,
                    { error_type: 'invalid_token' }
                );

            case 'INSUFFICIENT_PERMISSIONS':
                return this.sendError(res,
                    'Insufficient permissions to access user profile. Please ensure you grant all required permissions.',
                    403,
                    { error_type: 'insufficient_permissions' }
                );

            default:
                // Generic error handling
                const statusCode = error.statusCode || 500;
                const isServerError = statusCode >= 500;

                return this.sendError(res,
                    isServerError
                        ? 'An internal error occurred during authentication. Please try again.'
                        : error.message || 'Authentication failed',
                    statusCode,
                    {
                        error_type: 'authentication_error',
                        ...(error.code && { error_code: error.code })
                    }
                );
        }
    }

    /**
     * Get user-friendly OAuth error message
     * @param {string} error - OAuth error code
     * @param {string} errorDescription - OAuth error description
     * @returns {string} User-friendly error message
     */
    getOAuthErrorMessage(error, errorDescription) {
        const errorMessages = {
            'access_denied': 'You cancelled the sign-in process. Please try again to access the application.',
            'invalid_request': 'Invalid authentication request. Please try signing in again.',
            'unauthorized_client': 'Authentication service configuration error. Please contact support.',
            'unsupported_response_type': 'Authentication service configuration error. Please contact support.',
            'invalid_scope': 'Authentication service configuration error. Please contact support.',
            'server_error': 'Google authentication service is temporarily unavailable. Please try again.',
            'temporarily_unavailable': 'Google authentication service is temporarily unavailable. Please try again.'
        };

        return errorMessages[error] || errorDescription || 'Authentication failed. Please try again.';
    }

    /**
     * Refresh JWT token
     * Generate new token from existing valid token
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     */
    refreshToken = async (req, res) => {
        try {
            const authHeader = req.headers.authorization;

            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return this.sendError(res,
                    'Authorization header with Bearer token is required for token refresh',
                    401,
                    { error_type: 'missing_token' }
                );
            }

            const currentToken = authHeader.slice(7);

            // Refresh the token
            const newToken = this.jwtService.refreshToken(currentToken);

            // Decode new token to get user info
            const decoded = this.jwtService.verifyToken(newToken);

            const responseData = {
                success: true,
                token: newToken,
                expiresIn: this.jwtService.getTokenExpirationTime(),
                user: {
                    id: decoded.id,
                    email: decoded.email,
                    name: decoded.name,
                    picture: decoded.picture,
                    domain: decoded.domain
                }
            };

            return this.sendSuccess(res, responseData);

        } catch (error) {
            return this.handleAuthenticationError(error, res, 'Token refresh');
        }
    };

    /**
     * Logout user
     * Invalidate current session (client-side token removal)
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     */
    logout = async (req, res) => {
        try {
            // Note: JWT tokens are stateless, so we can't invalidate them server-side
            // without maintaining a blacklist. For now, we rely on client-side removal.
            // In a production environment, you might want to implement token blacklisting.

            const responseData = {
                success: true,
                message: 'Logged out successfully'
            };

            return this.sendSuccess(res, responseData);

        } catch (error) {
            console.error('Logout error:', error);
            return this.sendError(res,
                'Logout failed',
                500,
                { error_type: 'logout_error' }
            );
        }
    };

    /**
     * Get current user information
     * Return user data from JWT token
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     */
    getCurrentUser = async (req, res) => {
        try {
            // User information should be available from auth middleware
            const user = req.user;

            if (!user) {
                return this.sendError(res,
                    'User information not available',
                    401,
                    { error_type: 'no_user_context' }
                );
            }

            const responseData = {
                success: true,
                user: {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    picture: user.picture,
                    domain: user.domain
                }
            };

            return this.sendSuccess(res, responseData);

        } catch (error) {
            console.error('Get current user error:', error);
            return this.sendError(res,
                'Failed to retrieve user information',
                500,
                { error_type: 'user_info_error' }
            );
        }
    };

    /**
     * Get Google OAuth authorization URL
     * Generate URL for initiating OAuth flow
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     */
    getAuthUrl = async (req, res) => {
        try {
            const { state } = req.query;

            const authUrl = this.googleOAuthService.getAuthorizationUrl(state);

            const responseData = {
                success: true,
                authUrl: authUrl
            };

            return this.sendSuccess(res, responseData);

        } catch (error) {
            console.error('Get auth URL error:', error);
            return this.sendError(res,
                'Failed to generate authorization URL',
                500,
                { error_type: 'auth_url_error' }
            );
        }
    };

    /**
     * Health check for authentication service
     * Verify OAuth configuration and service availability
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     */
    healthCheck = async (req, res) => {
        try {
            // Validate OAuth configuration
            this.googleOAuthService.validateConfiguration();

            const responseData = {
                success: true,
                status: 'healthy',
                timestamp: new Date().toISOString(),
                services: {
                    oauth: 'configured',
                    jwt: 'configured'
                }
            };

            return this.sendSuccess(res, responseData);

        } catch (error) {
            return this.sendError(res,
                `Authentication service configuration error: ${error.message}`,
                503,
                { error_type: 'configuration_error' }
            );
        }
    };
}

module.exports = AuthController;