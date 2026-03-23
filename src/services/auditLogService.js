// src/services/auditLogService.js
const BaseService = require('./baseService');

/**
 * AuditLogService handles writing audit log entries to the database.
 * All writes are fire-and-forget — failures are logged but never
 * propagate to the caller, so audit logging can never break the API.
 */
class AuditLogService extends BaseService {
    /**
     * @param {AuditLogModel} auditLogModel - AuditLogModel instance
     */
    constructor(auditLogModel) {
        super();
        this.auditLogModel = auditLogModel;
    }

    /**
     * Write an audit log entry (fire-and-forget).
     * @param {Object} entry
     * @param {string} entry.action    - "CREATE", "UPDATE", "DELETE", "READ", "SEARCH", "LOGIN", "LOGOUT", etc.
     * @param {string} entry.entity    - "warehouse", "file", "auth"
     * @param {string} [entry.entityId]  - ID of the affected record
     * @param {string} [entry.context]   - Human-readable description
     * @param {Object} [entry.metadata]  - Arbitrary JSON payload
     * @param {string} entry.userEmail - Email of the acting user
     * @param {string} [entry.userName]  - Display name of the acting user
     * @param {string} [entry.ipAddress] - IP address of the request
     */
    async log(entry) {
        try {
            await this.auditLogModel.create({
                action: entry.action,
                entity: entry.entity,
                entityId: entry.entityId != null ? String(entry.entityId) : null,
                context: entry.context || null,
                metadata: entry.metadata || null,
                userEmail: entry.userEmail,
                userName: entry.userName || null,
                ipAddress: entry.ipAddress || null
            });
        } catch (error) {
            // Never let audit logging break the request — just log and move on
            console.error('AuditLogService: failed to write audit entry', {
                entry,
                error: error.message
            });
        }
    }
}

module.exports = AuditLogService;
