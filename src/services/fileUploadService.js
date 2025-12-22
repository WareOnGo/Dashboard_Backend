// src/services/fileUploadService.js
const BaseService = require('./baseService');
const WarehouseValidator = require('../validators/warehouseValidator');
const s3ClientManager = require('../utils/s3Client');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');

/**
 * FileUploadService class for handling file upload operations
 * Contains all business logic for S3/R2 file operations
 */
class FileUploadService extends BaseService {
    constructor() {
        super();
        this.s3Client = s3ClientManager.getClient();
        this.bucketName = s3ClientManager.getBucketName();
        this.publicUrlBase = s3ClientManager.getPublicUrlBase();
        
        // Validate S3 configuration on initialization
        if (!s3ClientManager.validateConfig()) {
            throw new Error('Invalid S3 configuration. Please check environment variables.');
        }
    }

    /**
     * Generate a presigned URL for file upload
     * @param {Object} uploadRequest - Upload request data
     * @param {string} uploadRequest.contentType - MIME type of the file
     * @param {Object} options - Additional options
     * @param {number} options.expiresIn - URL expiration time in seconds (default: 360)
     * @param {string} options.keyPrefix - Prefix for the generated key (default: '')
     * @returns {Object} Upload URL and final image URL
     */
    async generatePresignedUrl(uploadRequest, options = {}) {
        return this.executeOperation(async () => {
            // Validate upload request
            const validatedRequest = this.validateData(uploadRequest, (data) => WarehouseValidator.validateFileUpload(data));
            
            // Apply business rules for file upload
            const processedRequest = this.applyFileUploadBusinessRules(validatedRequest, options);
            
            // Generate unique file name
            const fileName = this.generateUniqueFileName(processedRequest.contentType, options.keyPrefix);
            
            // Create S3 command
            const command = new PutObjectCommand({
                Bucket: this.bucketName,
                Key: fileName,
                ContentType: processedRequest.contentType,
                // Add any additional metadata
                Metadata: this.buildFileMetadata(processedRequest, options)
            });

            try {
                // Generate presigned URL
                const signedUrl = await getSignedUrl(
                    this.s3Client, 
                    command, 
                    { expiresIn: options.expiresIn || 360 }
                );
                
                // Generate final public URL
                const finalImageUrl = this.buildPublicUrl(fileName);
                
                // Apply post-generation business logic
                return this.transformUploadResponse({
                    uploadUrl: signedUrl,
                    imageUrl: finalImageUrl,
                    fileName: fileName,
                    contentType: processedRequest.contentType,
                    expiresAt: new Date(Date.now() + (options.expiresIn || 360) * 1000).toISOString()
                });
                
            } catch (error) {
                this.handleS3Error(error);
            }
        });
    }

    /**
     * Generate multiple presigned URLs for batch upload
     * @param {Array} uploadRequests - Array of upload requests
     * @param {Object} options - Additional options
     * @returns {Array} Array of upload URLs and final image URLs
     */
    async generateMultiplePresignedUrls(uploadRequests, options = {}) {
        return this.executeOperation(async () => {
            // Validate that we have an array
            if (!Array.isArray(uploadRequests)) {
                const error = new Error('Upload requests must be an array');
                error.name = 'ValidationError';
                throw error;
            }
            
            // Validate batch size
            if (uploadRequests.length > (options.maxBatchSize || 10)) {
                const error = new Error(`Batch size cannot exceed ${options.maxBatchSize || 10} files`);
                error.name = 'ValidationError';
                throw error;
            }
            
            // Generate presigned URLs for each request
            const results = await Promise.all(
                uploadRequests.map((request, index) => 
                    this.generatePresignedUrl(request, {
                        ...options,
                        keyPrefix: options.keyPrefix ? `${options.keyPrefix}_${index}` : `batch_${index}`
                    })
                )
            );
            
            return {
                uploads: results,
                batchId: this.generateBatchId(),
                totalFiles: results.length
            };
        });
    }

    /**
     * Validate uploaded file (post-upload validation)
     * @param {string} fileName - Name of the uploaded file
     * @param {Object} validationOptions - Validation options
     * @returns {Object} Validation result
     */
    async validateUploadedFile(fileName, validationOptions = {}) {
        return this.executeOperation(async () => {
            // This would typically involve checking if the file exists in S3
            // and validating its properties
            const fileUrl = this.buildPublicUrl(fileName);
            
            // Apply business rules for file validation
            const validationResult = await this.applyFileValidationBusinessRules(fileName, validationOptions);
            
            return {
                fileName,
                fileUrl,
                isValid: validationResult.isValid,
                validationErrors: validationResult.errors || [],
                fileSize: validationResult.fileSize,
                lastModified: validationResult.lastModified
            };
        });
    }

    /**
     * Delete an uploaded file
     * @param {string} fileName - Name of the file to delete
     * @returns {boolean} True if deleted successfully
     */
    async deleteUploadedFile(fileName) {
        return this.executeOperation(async () => {
            // Apply business rules for file deletion
            await this.applyFileDeletionBusinessRules(fileName);
            
            try {
                const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
                const command = new DeleteObjectCommand({
                    Bucket: this.bucketName,
                    Key: fileName
                });
                
                await this.s3Client.send(command);
                return true;
                
            } catch (error) {
                this.handleS3Error(error);
            }
        });
    }

    /**
     * Get file information
     * @param {string} fileName - Name of the file
     * @returns {Object} File information
     */
    async getFileInfo(fileName) {
        return this.executeOperation(async () => {
            try {
                const { HeadObjectCommand } = require('@aws-sdk/client-s3');
                const command = new HeadObjectCommand({
                    Bucket: this.bucketName,
                    Key: fileName
                });
                
                const response = await this.s3Client.send(command);
                
                return this.transformFileInfo({
                    fileName,
                    fileUrl: this.buildPublicUrl(fileName),
                    contentType: response.ContentType,
                    contentLength: response.ContentLength,
                    lastModified: response.LastModified,
                    metadata: response.Metadata || {}
                });
                
            } catch (error) {
                if (error.name === 'NotFound') {
                    const notFoundError = new Error(`File ${fileName} not found`);
                    notFoundError.name = 'NotFoundError';
                    notFoundError.statusCode = 404;
                    throw notFoundError;
                }
                this.handleS3Error(error);
            }
        });
    }

    /**
     * Apply business rules for file upload
     * @param {Object} request - Validated upload request
     * @param {Object} options - Additional options
     * @returns {Object} Processed request
     * @private
     */
    applyFileUploadBusinessRules(request, options) {
        const processedRequest = { ...request };
        
        // Validate file type against business rules
        const allowedTypes = options.allowedTypes || [
            'image/jpeg',
            'image/png',
            'image/gif',
            'image/webp',
            'application/pdf'
        ];
        
        if (!allowedTypes.includes(processedRequest.contentType)) {
            const error = new Error(`File type ${processedRequest.contentType} is not allowed`);
            error.name = 'ValidationError';
            throw error;
        }
        
        // Apply size restrictions (this would be enforced on the client side)
        const maxFileSize = options.maxFileSize || 10 * 1024 * 1024; // 10MB default
        if (options.expectedFileSize && options.expectedFileSize > maxFileSize) {
            const error = new Error(`File size cannot exceed ${maxFileSize} bytes`);
            error.name = 'ValidationError';
            throw error;
        }
        
        return processedRequest;
    }

    /**
     * Apply business rules for file validation
     * @param {string} fileName - File name
     * @param {Object} options - Validation options
     * @returns {Object} Validation result
     * @private
     */
    async applyFileValidationBusinessRules(fileName, options) {
        // This is a placeholder for actual file validation logic
        // In a real implementation, you might:
        // - Check file size
        // - Validate file content
        // - Scan for malware
        // - Check file integrity
        
        return {
            isValid: true,
            errors: [],
            fileSize: null,
            lastModified: null
        };
    }

    /**
     * Apply business rules for file deletion
     * @param {string} fileName - File name
     * @private
     */
    async applyFileDeletionBusinessRules(fileName) {
        // Add any business logic for file deletion
        // For example: check if file is referenced by any warehouse records
        // This is a placeholder for future business rules
    }

    /**
     * Generate unique file name
     * @param {string} contentType - MIME type
     * @param {string} keyPrefix - Optional prefix
     * @returns {string} Unique file name
     * @private
     */
    generateUniqueFileName(contentType, keyPrefix = '') {
        const rawBytes = crypto.randomBytes(16);
        const uniqueId = rawBytes.toString('hex');
        
        // Get file extension from content type
        const extension = this.getFileExtensionFromContentType(contentType);
        
        // Build file name
        const fileName = keyPrefix ? `${keyPrefix}_${uniqueId}${extension}` : `${uniqueId}${extension}`;
        
        return fileName;
    }

    /**
     * Get file extension from content type
     * @param {string} contentType - MIME type
     * @returns {string} File extension
     * @private
     */
    getFileExtensionFromContentType(contentType) {
        const extensionMap = {
            'image/jpeg': '.jpg',
            'image/jpg': '.jpg',
            'image/png': '.png',
            'image/gif': '.gif',
            'image/webp': '.webp',
            'application/pdf': '.pdf'
        };
        
        return extensionMap[contentType] || '';
    }

    /**
     * Build file metadata
     * @param {Object} request - Upload request
     * @param {Object} options - Additional options
     * @returns {Object} File metadata
     * @private
     */
    buildFileMetadata(request, options) {
        return {
            'upload-timestamp': new Date().toISOString(),
            'content-type': request.contentType,
            'uploader': options.uploadedBy || 'system',
            'purpose': options.purpose || 'warehouse-image'
        };
    }

    /**
     * Build public URL for file
     * @param {string} fileName - File name
     * @returns {string} Public URL
     * @private
     */
    buildPublicUrl(fileName) {
        return `${this.publicUrlBase}/${fileName}`;
    }

    /**
     * Generate batch ID for multiple uploads
     * @returns {string} Batch ID
     * @private
     */
    generateBatchId() {
        return `batch_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    }

    /**
     * Transform upload response
     * @param {Object} response - Raw response
     * @returns {Object} Transformed response
     * @private
     */
    transformUploadResponse(response) {
        return {
            uploadUrl: response.uploadUrl,
            imageUrl: response.imageUrl,
            fileName: response.fileName,
            contentType: response.contentType,
            expiresAt: response.expiresAt,
            instructions: {
                method: 'PUT',
                headers: {
                    'Content-Type': response.contentType
                },
                note: 'Upload the file directly to the uploadUrl using a PUT request'
            }
        };
    }

    /**
     * Transform file info response
     * @param {Object} fileInfo - Raw file info
     * @returns {Object} Transformed file info
     * @private
     */
    transformFileInfo(fileInfo) {
        return {
            fileName: fileInfo.fileName,
            fileUrl: fileInfo.fileUrl,
            contentType: fileInfo.contentType,
            size: fileInfo.contentLength,
            lastModified: fileInfo.lastModified,
            metadata: fileInfo.metadata
        };
    }

    /**
     * Handle S3-specific errors
     * @param {Error} error - S3 error
     * @throws {Error} Processed error
     * @private
     */
    handleS3Error(error) {
        console.error('S3 Error:', error);
        
        // Map S3 errors to application errors
        if (error.name === 'NoSuchBucket') {
            const bucketError = new Error('Storage bucket not found');
            bucketError.name = 'ConfigurationError';
            bucketError.statusCode = 500;
            throw bucketError;
        }
        
        if (error.name === 'AccessDenied') {
            const accessError = new Error('Access denied to storage service');
            accessError.name = 'AuthorizationError';
            accessError.statusCode = 403;
            throw accessError;
        }
        
        if (error.name === 'InvalidRequest') {
            const requestError = new Error('Invalid storage request');
            requestError.name = 'ValidationError';
            requestError.statusCode = 400;
            throw requestError;
        }
        
        // Generic S3 error
        const genericError = new Error('File upload service error');
        genericError.name = 'ServiceError';
        genericError.statusCode = 500;
        genericError.originalError = error;
        throw genericError;
    }
}

module.exports = FileUploadService;