const BaseService = require('./baseService');
const { getAuthConfig } = require('../utils/config');

/**
 * Google OAuth Service for handling OAuth authentication flow
 * Manages token exchange, user profile retrieval, and domain validation
 */
class GoogleOAuthService extends BaseService {
    constructor() {
        super();
        this.config = getAuthConfig();
        this.googleTokenUrl = 'https://oauth2.googleapis.com/token';
        this.googleUserInfoUrl = 'https://www.googleapis.com/oauth2/v2/userinfo';
    }

    /**
     * Exchange OAuth authorization code for access tokens
     * @param {string} code - OAuth authorization code from Google
     * @returns {Promise<Object>} Token response from Google
     * @throws {Error} If token exchange fails
     */
    async exchangeCodeForTokens(code) {
        try {
            if (!code || typeof code !== 'string') {
                const error = new Error('Authorization code is required and must be a string');
                error.code = 'INVALID_AUTH_CODE';
                error.statusCode = 400;
                throw error;
            }

            const tokenRequestBody = {
                client_id: this.config.oauth.google.clientId,
                client_secret: this.config.oauth.google.clientSecret,
                code: code,
                grant_type: 'authorization_code',
                redirect_uri: this.config.oauth.google.redirectUri
            };

            let response;
            try {
                response = await fetch(this.googleTokenUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': 'application/json'
                    },
                    body: new URLSearchParams(tokenRequestBody),
                    timeout: 10000 // 10 second timeout
                });
            } catch (fetchError) {
                const error = new Error('Failed to connect to Google OAuth service');
                error.code = 'OAUTH_SERVICE_UNAVAILABLE';
                error.statusCode = 503;
                error.originalError = fetchError.message;
                throw error;
            }

            if (!response.ok) {
                let errorData = {};
                try {
                    errorData = await response.json();
                } catch (parseError) {
                    // Ignore JSON parse errors for error responses
                }

                const error = new Error(`Google OAuth token exchange failed: ${errorData.error_description || response.statusText}`);
                
                // Map Google OAuth error codes to our error types
                if (response.status === 400) {
                    if (errorData.error === 'invalid_grant') {
                        error.code = 'INVALID_AUTH_CODE';
                        error.message = 'Authorization code is invalid or expired';
                    } else if (errorData.error === 'invalid_client') {
                        error.code = 'OAUTH_CONFIG_ERROR';
                        error.message = 'OAuth client configuration is invalid';
                    } else {
                        error.code = 'OAUTH_REQUEST_ERROR';
                    }
                } else if (response.status === 401) {
                    error.code = 'OAUTH_UNAUTHORIZED';
                    error.message = 'OAuth client authentication failed';
                } else if (response.status >= 500) {
                    error.code = 'OAUTH_SERVICE_ERROR';
                    error.message = 'Google OAuth service is temporarily unavailable';
                } else {
                    error.code = 'OAUTH_UNKNOWN_ERROR';
                }
                
                error.statusCode = response.status;
                error.googleError = errorData;
                throw error;
            }

            let tokenData;
            try {
                tokenData = await response.json();
            } catch (parseError) {
                const error = new Error('Invalid response format from Google OAuth service');
                error.code = 'OAUTH_RESPONSE_ERROR';
                error.statusCode = 502;
                throw error;
            }

            // Validate required token fields
            if (!tokenData.access_token) {
                const error = new Error('Invalid token response: missing access_token');
                error.code = 'OAUTH_RESPONSE_ERROR';
                error.statusCode = 502;
                throw error;
            }

            return {
                accessToken: tokenData.access_token,
                refreshToken: tokenData.refresh_token,
                expiresIn: tokenData.expires_in,
                tokenType: tokenData.token_type || 'Bearer',
                scope: tokenData.scope
            };

        } catch (error) {
            // Ensure error has proper structure for upstream handling
            if (!error.code) {
                error.code = 'OAUTH_TOKEN_EXCHANGE_ERROR';
            }
            if (!error.statusCode) {
                error.statusCode = 500;
            }
            
            this.handleError(error);
        }
    }

    /**
     * Retrieve user profile information from Google using access token
     * @param {string} accessToken - Google OAuth access token
     * @returns {Promise<Object>} User profile data
     * @throws {Error} If profile retrieval fails
     */
    async getUserProfile(accessToken) {
        try {
            if (!accessToken || typeof accessToken !== 'string') {
                const error = new Error('Access token is required and must be a string');
                error.code = 'INVALID_ACCESS_TOKEN';
                error.statusCode = 400;
                throw error;
            }

            let response;
            try {
                response = await fetch(this.googleUserInfoUrl, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Accept': 'application/json'
                    },
                    timeout: 10000 // 10 second timeout
                });
            } catch (fetchError) {
                const error = new Error('Failed to connect to Google user info service');
                error.code = 'GOOGLE_API_UNAVAILABLE';
                error.statusCode = 503;
                error.originalError = fetchError.message;
                throw error;
            }

            if (!response.ok) {
                let errorData = {};
                try {
                    errorData = await response.json();
                } catch (parseError) {
                    // Ignore JSON parse errors for error responses
                }

                const error = new Error(`Google profile retrieval failed: ${response.status} - ${errorData.error_description || response.statusText}`);
                
                if (response.status === 401) {
                    error.code = 'INVALID_ACCESS_TOKEN';
                    error.message = 'Access token is invalid or expired';
                } else if (response.status === 403) {
                    error.code = 'INSUFFICIENT_PERMISSIONS';
                    error.message = 'Access token does not have required permissions';
                } else if (response.status >= 500) {
                    error.code = 'GOOGLE_API_ERROR';
                    error.message = 'Google user info service is temporarily unavailable';
                } else {
                    error.code = 'PROFILE_RETRIEVAL_ERROR';
                }
                
                error.statusCode = response.status;
                error.googleError = errorData;
                throw error;
            }

            let profileData;
            try {
                profileData = await response.json();
            } catch (parseError) {
                const error = new Error('Invalid response format from Google user info service');
                error.code = 'GOOGLE_API_RESPONSE_ERROR';
                error.statusCode = 502;
                throw error;
            }

            // Validate required profile fields
            if (!profileData.id || !profileData.email) {
                const error = new Error('Invalid profile response: missing required fields (id, email)');
                error.code = 'INCOMPLETE_PROFILE_DATA';
                error.statusCode = 502;
                throw error;
            }

            // Validate email domain before returning profile
            if (!this.validateDomain(profileData.email)) {
                const domain = this.extractDomain(profileData.email);
                const error = new Error(`Access restricted to @${this.config.auth.allowedDomain} accounts. Found: @${domain}`);
                error.code = 'DOMAIN_RESTRICTED';
                error.statusCode = 403;
                error.userDomain = domain;
                error.allowedDomain = this.config.auth.allowedDomain;
                throw error;
            }

            return {
                id: profileData.id,
                email: profileData.email,
                name: profileData.name || '',
                picture: profileData.picture || '',
                verified_email: profileData.verified_email || false,
                locale: profileData.locale || 'en'
            };

        } catch (error) {
            // Ensure error has proper structure for upstream handling
            if (!error.code) {
                error.code = 'PROFILE_RETRIEVAL_ERROR';
            }
            if (!error.statusCode) {
                error.statusCode = 500;
            }
            
            this.handleError(error);
        }
    }

    /**
     * Validate email domain against allowed domain restriction
     * @param {string} email - Email address to validate
     * @returns {boolean} True if domain is allowed, false otherwise
     */
    validateDomain(email) {
        try {
            if (!email || typeof email !== 'string') {
                return false;
            }

            // Extract domain from email
            const domain = this.extractDomain(email);
            const allowedDomain = this.config.auth.allowedDomain;

            // Case-insensitive domain comparison
            return domain.toLowerCase() === allowedDomain.toLowerCase();

        } catch (error) {
            // Log validation error but don't throw - return false for invalid emails
            console.warn(`Domain validation error: ${error.message}`);
            return false;
        }
    }

    /**
     * Extract domain from email address
     * @param {string} email - Email address
     * @returns {string} Domain part of email
     * @throws {Error} If email format is invalid
     */
    extractDomain(email) {
        if (!email || typeof email !== 'string') {
            throw new Error('Email must be a valid string');
        }

        if (!email.includes('@')) {
            throw new Error('Invalid email format: missing @ symbol');
        }

        const parts = email.split('@');
        if (parts.length !== 2 || !parts[1]) {
            throw new Error('Invalid email format: malformed domain');
        }

        return parts[1];
    }

    /**
     * Complete OAuth flow: exchange code for tokens and retrieve user profile
     * @param {string} code - OAuth authorization code
     * @returns {Promise<Object>} Complete user profile with tokens
     * @throws {Error} If OAuth flow fails
     */
    async completeOAuthFlow(code) {
        try {
            // Step 1: Exchange code for tokens
            const tokenData = await this.exchangeCodeForTokens(code);

            // Step 2: Get user profile using access token
            const userProfile = await this.getUserProfile(tokenData.accessToken);

            // Return combined result
            return {
                user: userProfile,
                tokens: {
                    accessToken: tokenData.accessToken,
                    refreshToken: tokenData.refreshToken,
                    expiresIn: tokenData.expiresIn,
                    tokenType: tokenData.tokenType
                }
            };

        } catch (error) {
            // Pass through structured errors from sub-methods
            if (error.code && error.statusCode) {
                throw error;
            }
            
            // Wrap unstructured errors
            const wrappedError = new Error(`OAuth flow completion failed: ${error.message}`);
            wrappedError.code = 'OAUTH_FLOW_ERROR';
            wrappedError.statusCode = 500;
            wrappedError.originalError = error.message;
            
            this.handleError(wrappedError);
        }
    }

    /**
     * Validate OAuth configuration
     * @returns {boolean} True if configuration is valid
     * @throws {Error} If configuration is invalid
     */
    validateConfiguration() {
        const requiredFields = [
            { name: 'Google Client ID', value: this.config.oauth.google.clientId },
            { name: 'Google Client Secret', value: this.config.oauth.google.clientSecret },
            { name: 'Redirect URI', value: this.config.oauth.google.redirectUri },
            { name: 'Allowed Domain', value: this.config.auth.allowedDomain }
        ];

        const missingFields = requiredFields.filter(field => !field.value);

        if (missingFields.length > 0) {
            const missing = missingFields.map(field => field.name).join(', ');
            throw new Error(`OAuth configuration incomplete: missing ${missing}`);
        }

        return true;
    }

    /**
     * Get OAuth authorization URL for redirecting users to Google
     * @param {string} [state] - Optional state parameter for CSRF protection
     * @returns {string} Google OAuth authorization URL
     */
    getAuthorizationUrl(state = null) {
        const params = new URLSearchParams({
            client_id: this.config.oauth.google.clientId,
            redirect_uri: this.config.oauth.google.redirectUri,
            response_type: 'code',
            scope: 'openid email profile',
            access_type: 'offline',
            prompt: 'consent'
        });

        if (state) {
            params.append('state', state);
        }

        return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    }
}

module.exports = GoogleOAuthService;