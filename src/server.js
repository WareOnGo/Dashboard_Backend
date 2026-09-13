// Process startup stays separate so tests use the production app without listening
// or connecting to a database as an import side effect.
const app = require('./app');
const database = require('./utils/database');
const PORT = process.env.PORT || 3001;

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
 * Request timeouts.
 *
 * App Runner terminates any request at ~120s and exposes no setting to change
 * it (verified against CloudWatch: RequestLatency maxes at exactly 125,000ms
 * across months of traffic, and a longer run has a matching 5xx at ~120s).
 *
 * These are set just *under* that ceiling so Node gives up when the platform
 * does. The proposal engine used 600s, which was unreachable — it only meant a
 * detailed deck kept generating for up to 18 minutes on a socket that had been
 * dead for 16 of them, then logged success for a response nobody received.
 *
 * headersTimeout must exceed keepAliveTimeout, or Node can close a connection
 * mid-request.
 */
server.timeout = 115000;
server.keepAliveTimeout = 115000;
server.headersTimeout = 120000;

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
