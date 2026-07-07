// src/models/appSettingModel.js
const BaseModel = require('./baseModel');

/**
 * AppSettingModel — persistence for the generic, application-namespaced runtime
 * settings store (app_setting table). One row per (application, key); `value` is
 * JSONB. See prisma/schema.prisma AppSetting.
 */
class AppSettingModel extends BaseModel {
    constructor(prismaClient = null) {
        super(prismaClient);
        this.model = this.prisma.appSetting;
    }

    /**
     * Fetch a single setting row.
     * @param {string} application
     * @param {string} key
     * @returns {Object|null} The row (with `value`) or null if unset
     */
    async get(application, key) {
        try {
            return await this.model.findUnique({
                where: { application_key: { application, key } },
            });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Upsert a setting's value.
     * @param {string} application
     * @param {string} key
     * @param {*} value - JSON-serializable value (bool/string/number/object)
     * @param {string} [updatedBy] - Actor email for audit
     * @returns {Object} The upserted row
     */
    async set(application, key, value, updatedBy = null) {
        try {
            return await this.model.upsert({
                where: { application_key: { application, key } },
                update: { value, updatedBy },
                create: { application, key, value, updatedBy },
            });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }
}

module.exports = AppSettingModel;
