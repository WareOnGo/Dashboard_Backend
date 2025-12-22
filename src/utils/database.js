// src/utils/database.js
const { PrismaClient } = require('@prisma/client');

/**
 * Database utility class for managing Prisma client connection
 * 
 * Implements the singleton pattern to ensure only one database connection
 * is maintained throughout the application lifecycle. Provides methods for
 * connection management, health checks, and graceful shutdown.
 * 
 * @example
 * const database = require('./utils/database');
 * 
 * // Connect to database
 * await database.connect();
 * 
 * // Get client instance
 * const prisma = database.getClient();
 * 
 * // Check health
 * const isHealthy = await database.healthCheck();
 * 
 * // Disconnect
 * await database.disconnect();
 */
class Database {
    /**
     * Create a new Database instance
     * Initializes with null Prisma client (lazy initialization)
     */
    constructor() {
        /**
         * Prisma client instance (singleton)
         * @type {PrismaClient|null}
         * @private
         */
        this.prisma = null;
    }

    /**
     * Get or create Prisma client instance (singleton pattern)
     * 
     * Creates a new Prisma client if one doesn't exist, otherwise returns
     * the existing instance. Configures logging based on environment.
     * 
     * @returns {PrismaClient} Prisma client instance
     * 
     * @example
     * const database = require('./utils/database');
     * const prisma = database.getClient();
     * 
     * // Use the client for database operations
     * const users = await prisma.user.findMany();
     */
    getClient() {
        if (!this.prisma) {
            this.prisma = new PrismaClient({
                log: process.env.NODE_ENV === 'development' 
                    ? ['query', 'info', 'warn', 'error'] 
                    : ['error'],
            });
        }
        return this.prisma;
    }

    /**
     * Connect to the database
     * 
     * Establishes connection to the PostgreSQL database using Prisma.
     * Should be called during application startup.
     * 
     * @returns {Promise<void>}
     * @throws {Error} If connection fails
     * 
     * @example
     * try {
     *   await database.connect();
     *   console.log('Database connected successfully');
     * } catch (error) {
     *   console.error('Failed to connect:', error);
     *   process.exit(1);
     * }
     */
    async connect() {
        try {
            const client = this.getClient();
            await client.$connect();
            console.log('Database connected successfully');
        } catch (error) {
            console.error('Failed to connect to database:', error);
            throw error;
        }
    }

    /**
     * Disconnect from the database
     * 
     * Gracefully closes the database connection. Should be called during
     * application shutdown to ensure proper cleanup.
     * 
     * @returns {Promise<void>}
     * @throws {Error} If disconnection fails
     * 
     * @example
     * // During graceful shutdown
     * process.on('SIGTERM', async () => {
     *   await database.disconnect();
     *   process.exit(0);
     * });
     */
    async disconnect() {
        try {
            if (this.prisma) {
                await this.prisma.$disconnect();
                console.log('Database disconnected successfully');
            }
        } catch (error) {
            console.error('Error disconnecting from database:', error);
            throw error;
        }
    }

    /**
     * Check database connection health
     * 
     * Performs a simple query to verify that the database connection
     * is working properly. Used by health check endpoints.
     * 
     * @returns {Promise<boolean>} True if connection is healthy, false otherwise
     * 
     * @example
     * // In health check endpoint
     * app.get('/health', async (req, res) => {
     *   const dbHealthy = await database.healthCheck();
     *   res.json({ 
     *     database: dbHealthy ? 'connected' : 'disconnected' 
     *   });
     * });
     */
    async healthCheck() {
        try {
            const client = this.getClient();
            await client.$queryRaw`SELECT 1`;
            return true;
        } catch (error) {
            console.error('Database health check failed:', error);
            return false;
        }
    }

    /**
     * Execute a raw SQL query
     * 
     * Provides direct access to raw SQL queries when Prisma's query builder
     * is insufficient. Use with caution and ensure proper parameterization.
     * 
     * @param {string} query - SQL query string
     * @param {...*} params - Query parameters
     * @returns {Promise<*>} Query result
     * @throws {Error} If query execution fails
     * 
     * @example
     * const result = await database.executeRaw(
     *   'SELECT COUNT(*) as count FROM warehouses WHERE city = $1',
     *   'New York'
     * );
     */
    async executeRaw(query, ...params) {
        try {
            const client = this.getClient();
            return await client.$queryRawUnsafe(query, ...params);
        } catch (error) {
            console.error('Raw query execution failed:', error);
            throw error;
        }
    }

    /**
     * Execute a database transaction
     * 
     * Wraps multiple database operations in a transaction to ensure
     * data consistency. All operations succeed or all fail.
     * 
     * @param {Function} operations - Function containing database operations
     * @returns {Promise<*>} Transaction result
     * @throws {Error} If transaction fails
     * 
     * @example
     * const result = await database.transaction(async (prisma) => {
     *   const user = await prisma.user.create({ data: userData });
     *   const profile = await prisma.profile.create({ 
     *     data: { ...profileData, userId: user.id } 
     *   });
     *   return { user, profile };
     * });
     */
    async transaction(operations) {
        try {
            const client = this.getClient();
            return await client.$transaction(operations);
        } catch (error) {
            console.error('Transaction failed:', error);
            throw error;
        }
    }
}

/**
 * Singleton database instance
 * Export a single instance to be used throughout the application
 * 
 * @type {Database}
 */
const database = new Database();

module.exports = database;