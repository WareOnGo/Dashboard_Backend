// src/utils/s3Client.js
const { S3Client } = require('@aws-sdk/client-s3');

/**
 * S3 client utility for managing AWS S3/Cloudflare R2 connections
 * 
 * Provides a singleton S3 client instance configured for Cloudflare R2
 * (S3-compatible storage). Handles client initialization, configuration
 * validation, and provides helper methods for bucket operations.
 * 
 * Environment Variables Required:
 * - R2_ACCOUNT_ID: Cloudflare account ID
 * - R2_ACCESS_KEY_ID: R2 access key ID
 * - R2_SECRET_ACCESS_KEY: R2 secret access key
 * - R2_BUCKET_NAME: Name of the R2 bucket
 * - R2_PUBLIC_URL: Public URL base for accessing files
 * 
 * @example
 * const s3ClientManager = require('./utils/s3Client');
 * 
 * // Validate configuration
 * if (!s3ClientManager.validateConfig()) {
 *   throw new Error('Invalid S3 configuration');
 * }
 * 
 * // Get client instance
 * const s3Client = s3ClientManager.getClient();
 * 
 * // Get bucket info
 * const bucketName = s3ClientManager.getBucketName();
 * const publicUrl = s3ClientManager.getPublicUrlBase();
 */
class S3ClientManager {
    /**
     * Create a new S3ClientManager instance
     * Initializes with null client (lazy initialization)
     */
    constructor() {
        /**
         * S3 client instance (singleton)
         * @type {S3Client|null}
         * @private
         */
        this.client = null;
    }

    /**
     * Get or create S3 client instance (singleton pattern)
     * 
     * Creates a new S3 client configured for Cloudflare R2 if one doesn't exist,
     * otherwise returns the existing instance. Uses 'auto' region and R2 endpoint.
     * 
     * @returns {S3Client} S3 client instance configured for Cloudflare R2
     * @throws {Error} If required environment variables are missing
     * 
     * @example
     * const s3ClientManager = require('./utils/s3Client');
     * const s3Client = s3ClientManager.getClient();
     * 
     * // Use with AWS SDK commands
     * const { PutObjectCommand } = require('@aws-sdk/client-s3');
     * const command = new PutObjectCommand({
     *   Bucket: 'my-bucket',
     *   Key: 'my-file.jpg',
     *   Body: fileBuffer
     * });
     * await s3Client.send(command);
     */
    getClient() {
        if (!this.client) {
            // Validate required environment variables
            if (!this.validateConfig()) {
                throw new Error('Invalid S3 configuration. Please check environment variables.');
            }

            this.client = new S3Client({
                region: 'auto',
                endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
                credentials: {
                    accessKeyId: process.env.R2_ACCESS_KEY_ID,
                    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
                },
            });
        }
        return this.client;
    }

    /**
     * Validate S3/R2 configuration
     * 
     * Checks that all required environment variables are present.
     * Should be called before attempting to use the S3 client.
     * 
     * @returns {boolean} True if all required environment variables are present
     * 
     * @example
     * const s3ClientManager = require('./utils/s3Client');
     * 
     * if (!s3ClientManager.validateConfig()) {
     *   console.error('S3 configuration is invalid');
     *   process.exit(1);
     * }
     */
    validateConfig() {
        /**
         * Required environment variables for R2 configuration
         * @type {string[]}
         */
        const requiredEnvVars = [
            'R2_ACCOUNT_ID',
            'R2_ACCESS_KEY_ID',
            'R2_SECRET_ACCESS_KEY',
            'R2_BUCKET_NAME',
            'R2_PUBLIC_URL'
        ];

        const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
        
        if (missingVars.length > 0) {
            console.error('Missing required S3 environment variables:', missingVars);
            return false;
        }

        return true;
    }

    /**
     * Get bucket name from environment
     * 
     * @returns {string} The configured R2 bucket name
     * @throws {Error} If R2_BUCKET_NAME environment variable is not set
     * 
     * @example
     * const bucketName = s3ClientManager.getBucketName();
     * console.log('Using bucket:', bucketName);
     */
    getBucketName() {
        const bucketName = process.env.R2_BUCKET_NAME;
        if (!bucketName) {
            throw new Error('R2_BUCKET_NAME environment variable is not set');
        }
        return bucketName;
    }

    /**
     * Get public URL base from environment
     * 
     * Returns the base URL for accessing files publicly. Files uploaded
     * to the bucket can be accessed at: {publicUrlBase}/{fileName}
     * 
     * @returns {string} The configured public URL base (without trailing slash)
     * @throws {Error} If R2_PUBLIC_URL environment variable is not set
     * 
     * @example
     * const publicUrlBase = s3ClientManager.getPublicUrlBase();
     * const fileUrl = `${publicUrlBase}/my-file.jpg`;
     * console.log('File accessible at:', fileUrl);
     */
    getPublicUrlBase() {
        const publicUrl = process.env.R2_PUBLIC_URL;
        if (!publicUrl) {
            throw new Error('R2_PUBLIC_URL environment variable is not set');
        }
        // Remove trailing slash if present
        return publicUrl.replace(/\/$/, '');
    }

    /**
     * Get the full endpoint URL for the R2 service
     * 
     * @returns {string} The R2 endpoint URL
     * @throws {Error} If R2_ACCOUNT_ID environment variable is not set
     * 
     * @example
     * const endpoint = s3ClientManager.getEndpoint();
     * console.log('R2 endpoint:', endpoint);
     */
    getEndpoint() {
        const accountId = process.env.R2_ACCOUNT_ID;
        if (!accountId) {
            throw new Error('R2_ACCOUNT_ID environment variable is not set');
        }
        return `https://${accountId}.r2.cloudflarestorage.com`;
    }

    /**
     * Test the S3 connection
     * 
     * Attempts to list objects in the bucket to verify connectivity
     * and permissions. Useful for health checks and configuration validation.
     * 
     * @returns {Promise<boolean>} True if connection test succeeds
     * 
     * @example
     * const isConnected = await s3ClientManager.testConnection();
     * if (!isConnected) {
     *   console.error('S3 connection test failed');
     * }
     */
    async testConnection() {
        try {
            const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
            const client = this.getClient();
            const command = new ListObjectsV2Command({
                Bucket: this.getBucketName(),
                MaxKeys: 1
            });
            
            await client.send(command);
            return true;
        } catch (error) {
            console.error('S3 connection test failed:', error);
            return false;
        }
    }

    /**
     * Get configuration summary
     * 
     * Returns a summary of the current S3 configuration for debugging
     * and logging purposes. Excludes sensitive information.
     * 
     * @returns {Object} Configuration summary
     * 
     * @example
     * const config = s3ClientManager.getConfigSummary();
     * console.log('S3 Configuration:', config);
     */
    getConfigSummary() {
        return {
            endpoint: this.getEndpoint(),
            bucketName: this.getBucketName(),
            publicUrlBase: this.getPublicUrlBase(),
            hasCredentials: !!(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY),
            isConfigValid: this.validateConfig()
        };
    }
}

/**
 * Singleton S3 client manager instance
 * Export a single instance to be used throughout the application
 * 
 * @type {S3ClientManager}
 */
const s3ClientManager = new S3ClientManager();

module.exports = s3ClientManager;