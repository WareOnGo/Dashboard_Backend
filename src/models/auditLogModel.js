// src/models/auditLogModel.js
const BaseModel = require('./baseModel');

/**
 * AuditLogModel class for handling audit log data operations
 * Extends BaseModel to provide audit-log-specific database operations
 */
class AuditLogModel extends BaseModel {
    constructor(prismaClient = null) {
        super(prismaClient);
        this.model = this.prisma.auditLog;
    }

    /**
     * Find audit logs by entity and optional entityId
     * @param {string} entity - Entity type (e.g. "warehouse", "file")
     * @param {string} [entityId] - Optional entity ID
     * @param {Object} [options] - Query options (skip, take, orderBy)
     * @returns {Array} Array of audit log entries
     */
    async findByEntity(entity, entityId, options = {}) {
        try {
            const where = { entity };
            if (entityId) where.entityId = entityId;

            return await this.model.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                ...options
            });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Find audit logs by user email
     * @param {string} userEmail - User email address
     * @param {Object} [options] - Query options
     * @returns {Array} Array of audit log entries
     */
    async findByUser(userEmail, options = {}) {
        try {
            return await this.model.findMany({
                where: { userEmail },
                orderBy: { createdAt: 'desc' },
                ...options
            });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Find audit logs by action type
     * @param {string} action - Action type (e.g. "CREATE", "DELETE")
     * @param {Object} [options] - Query options
     * @returns {Array} Array of audit log entries
     */
    async findByAction(action, options = {}) {
        try {
            return await this.model.findMany({
                where: { action },
                orderBy: { createdAt: 'desc' },
                ...options
            });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }
}

module.exports = AuditLogModel;
