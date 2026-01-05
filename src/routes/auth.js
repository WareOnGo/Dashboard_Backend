// src/routes/auth.js
const express = require('express');
const router = express.Router();
const AuthController = require('../controllers/authController');
const AuthMiddleware = require('../middleware/authMiddleware');

// Create controller instance
const authController = new AuthController();

// Create middleware instance
const authMiddleware = new AuthMiddleware();

// --- OAuth Routes ---

/**
 * GET /auth/google
 * Get Google OAuth authorization URL for initiating authentication flow
 * @returns {Object} Authorization URL for redirecting to Google OAuth
 */
router.get('/google', (req, res, next) => authController.getAuthUrl(req, res).catch(next));

/**
 * POST /auth/google/callback
 * Handle Google OAuth callback with authorization code
 * Exchanges code for user profile and generates JWT token
 * @body {string} code - OAuth authorization code from Google
 * @returns {Object} User profile and JWT token
 */
router.post('/google/callback', (req, res, next) => authController.handleOAuthCallback(req, res).catch(next));

/**
 * GET /auth/google/callback
 * Handle Google OAuth callback via GET (for redirect-based flow)
 * Exchanges code for user profile and generates JWT token
 * @query {string} code - OAuth authorization code from Google
 * @query {string} [error] - OAuth error if authentication failed
 * @returns {Object} User profile and JWT token or error response
 */
router.get('/google/callback', (req, res, next) => authController.handleOAuthCallback(req, res).catch(next));

// --- Token Management Routes ---

/**
 * POST /auth/refresh
 * Refresh JWT token with a new expiration time
 * Requires valid JWT token in Authorization header
 * @header {string} Authorization - Bearer token
 * @returns {Object} New JWT token and user information
 */
router.post('/refresh', (req, res, next) => authController.refreshToken(req, res).catch(next));

/**
 * POST /auth/logout
 * Logout user and invalidate session
 * Note: JWT tokens are stateless, so this primarily serves as a client-side signal
 * @returns {Object} Success confirmation
 */
router.post('/logout', (req, res, next) => authController.logout(req, res).catch(next));

// --- User Information Routes ---

/**
 * GET /auth/me
 * Get current authenticated user information
 * Requires valid JWT token in Authorization header
 * @header {string} Authorization - Bearer token
 * @returns {Object} Current user profile information
 */
router.get('/me', authMiddleware.authenticateJWT, (req, res, next) => authController.getCurrentUser(req, res).catch(next));

// --- Service Health Routes ---

/**
 * GET /auth/health
 * Health check for authentication service
 * Verifies OAuth configuration and service availability
 * @returns {Object} Service health status and configuration check
 */
router.get('/health', (req, res, next) => authController.healthCheck(req, res).catch(next));

module.exports = router;