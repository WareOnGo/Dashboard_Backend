// src/app.js
const express = require('express');
const cors = require('cors');
require('dotenv').config();

// Import utilities
const database = require('./utils/database');

// Import middleware
const { ErrorHandler, ValidationMiddleware } = require('./middleware');

/**
 * Express application instance for the Warehouse Management API
 * 
 * This application follows MVC architecture with:
 * - Controllers for HTTP request handling
 * - Services for business logic
 * - Models for data access
 * - Middleware for cross-cutting concerns
 * 
 * @type {express.Application}
 */
const app = express();

/**
 * Server port from environment or default
 * @type {number}
 */
const PORT = process.env.PORT || 3001;

// --- Middleware Stack ---

/**
 * CORS configuration options
 * Allows cross-origin requests from specified origins
 * 
 * @type {Object}
 */
const corsOptions = {
    origin: [
        'https://dimnz4vlbe2vn.cloudfront.net',
        'https://dimnz4vlbe2vn.cloudfront.net/',
        process.env.CORS_ORIGIN || 'http://localhost:3000',
        'http://localhost:5173'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type', 
        'Authorization', 
        'X-Requested-With',
        'Accept',
        'Origin'
    ],
    exposedHeaders: [
        'X-Token-Refresh-Suggested',
        'X-Token-Expires-In'
    ],
    optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

/**
 * Body parsing middleware configuration
 * Handles JSON and URL-encoded request bodies with size limits
 */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

/**
 * Request sanitization middleware
 * Sanitizes all incoming request data to prevent XSS and injection attacks
 */
app.use(ValidationMiddleware.sanitizeAll());

/**
 * Request logging middleware
 * Logs all incoming requests with timestamp, method, and path
 * 
 * @param {express.Request} req - Express request object
 * @param {express.Response} res - Express response object
 * @param {express.NextFunction} next - Express next function
 */
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// --- Database Connection ---

/**
 * Initialize database connection
 * Connects to PostgreSQL database using Prisma ORM
 * Exits process if connection fails
 */
database.connect().catch(error => {
    console.error('Failed to connect to database:', error);
    process.exit(1);
});

// --- Routes ---

/**
 * Authentication API routes
 * Handles all authentication-related endpoints under /auth
 */
app.use('/auth', require('./routes/auth'));

/**
 * Warehouse API routes
 * Handles all warehouse-related endpoints under /api/warehouses
 */
app.use('/api/warehouses', require('./routes/warehouse'));

// --- Basic Test Route ---

/**
 * Root endpoint for API health check
 * Returns basic API information and status
 * 
 * @route GET /
 * @returns {Object} API status information
 */
app.get('/', (req, res) => {
    res.json({
        message: 'Warehouse API is running!',
        version: '2.0.0',
        architecture: 'MVC',
        timestamp: new Date().toISOString()
    });
});

// --- Health Check Route ---

/**
 * Health check endpoint
 * Verifies database connectivity and API status
 * 
 * @route GET /health
 * @returns {Object} Health status with service information
 * @returns {200} Healthy status
 * @returns {503} Unhealthy status
 */
app.get('/health', async (req, res) => {
    try {
        const dbHealthy = await database.healthCheck();
        const healthStatus = {
            status: dbHealthy ? 'healthy' : 'unhealthy',
            timestamp: new Date().toISOString(),
            services: {
                database: dbHealthy ? 'connected' : 'disconnected',
                api: 'running'
            },
            version: '2.0.0'
        };

        res.status(dbHealthy ? 200 : 503).json(healthStatus);
    } catch (error) {
        console.error('Health check error:', error);
        res.status(503).json({
            status: 'unhealthy',
            timestamp: new Date().toISOString(),
            error: 'Health check failed'
        });
    }
});

// --- 404 Handler ---

/**
 * 404 Not Found handler for undefined routes
 * Returns standardized error response for non-existent endpoints
 * 
 * @param {express.Request} req - Express request object
 * @param {express.Response} res - Express response object
 * @param {express.NextFunction} next - Express next function
 * @returns {Object} 404 error response
 */
app.use((req, res, next) => {
    res.status(404).json({
        error: 'Route not found',
        path: req.originalUrl,
        method: req.method,
        timestamp: new Date().toISOString()
    });
});

// --- Error Handling Middleware (must be last) ---

/**
 * Global error handling middleware
 * Processes all unhandled errors and returns standardized error responses
 * Must be registered last in the middleware stack
 */
app.use(ErrorHandler.handle);

// --- Graceful Shutdown ---

/**
 * Graceful shutdown handler
 * Properly closes database connections and exits the process
 * 
 * @param {string} signal - The signal that triggered the shutdown
 * @returns {Promise<void>}
 */
const gracefulShutdown = async (signal) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);

    try {
        // Close database connections
        await database.disconnect();
        console.log('Database connections closed.');

        // Exit process
        process.exit(0);
    } catch (error) {
        console.error('Error during graceful shutdown:', error);
        process.exit(1);
    }
};

// Register signal handlers for graceful shutdown
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

/**
 * Uncaught exception handler
 * Logs the error and initiates graceful shutdown
 * 
 * @param {Error} error - The uncaught exception
 */
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    gracefulShutdown('UNCAUGHT_EXCEPTION');
});

/**
 * Unhandled promise rejection handler
 * Logs the rejection and initiates graceful shutdown
 * 
 * @param {*} reason - The rejection reason
 * @param {Promise} promise - The rejected promise
 */
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    gracefulShutdown('UNHANDLED_REJECTION');
});

// --- Start Server ---

/**
 * HTTP server instance
 * Starts the Express application on the specified port
 * 
 * @type {http.Server}
 */
const server = app.listen(PORT, () => {
    console.log(`🚀 Warehouse API Server started successfully!`);
    console.log(`📍 Server listening on http://localhost:${PORT}`);
    console.log(`🏗️  Architecture: MVC Pattern`);
    console.log(`📊 Health Check: http://localhost:${PORT}/health`);
    console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
});

/**
 * Server error handler
 * Handles server startup errors and exits the process
 * 
 * @param {Error} error - Server error
 */
server.on('error', (error) => {
    console.error('Server error:', error);
    process.exit(1);
});

module.exports = app;