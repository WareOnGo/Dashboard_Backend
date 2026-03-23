// src/middleware/auditMiddleware.js

/**
 * Audit middleware factory.
 * Attaches a `req.audit(action, entity, entityId, context, metadata)` helper
 * to every request. The actual DB write happens asynchronously after
 * `res.on('finish')` so it never delays the response.
 *
 * @param {AuditLogService} auditLogService - Injected audit log service
 * @returns {Function} Express middleware
 */
function createAuditMiddleware(auditLogService) {
    return (req, res, next) => {
        // Queue of audit entries to flush after the response is sent
        const pending = [];

        /**
         * Queue an audit log entry.
         * @param {string} action   - "CREATE", "UPDATE", "DELETE", "READ", etc.
         * @param {string} entity   - "warehouse", "file", "auth"
         * @param {string|number|null} entityId - ID of the affected record
         * @param {string|null} context  - Human-readable message
         * @param {Object|null} metadata - Extra JSON payload
         */
        req.audit = (action, entity, entityId = null, context = null, metadata = null) => {
            pending.push({ action, entity, entityId, context, metadata });
        };

        // Flush all queued entries once the response has been sent
        res.on('finish', () => {
            if (pending.length === 0) return;

            const userEmail = req.user?.email || 'anonymous';
            const userName = req.user?.name || null;
            const ipAddress = req.ip || req.connection?.remoteAddress || null;

            for (const entry of pending) {
                // Fire-and-forget — AuditLogService.log() already swallows errors
                auditLogService.log({
                    ...entry,
                    userEmail,
                    userName,
                    ipAddress
                });
            }
        });

        next();
    };
}

module.exports = createAuditMiddleware;
