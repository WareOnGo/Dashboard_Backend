// src/services/settingsService.js
const BaseService = require('./baseService');

/** Application namespace for this dashboard's settings. */
const APPLICATION = 'dashboard';
/** Setting key for the auto-approve ("autopilot") toggle. */
const AUTO_APPROVE_KEY = 'auto_approve_submissions';
/**
 * Default when the auto-approve setting has never been written. `true` preserves
 * the historical hardcoded behavior (submissions auto-promote until a reviewer
 * turns autopilot off).
 */
const AUTO_APPROVE_DEFAULT = true;

/**
 * SettingsService — generic, application-namespaced runtime settings backed by
 * the app_setting table. Lets operational toggles (like auto-approve) be flipped
 * at runtime instead of via a code deploy.
 */
class SettingsService extends BaseService {
    constructor(appSettingModel) {
        super();
        this.appSettingModel = appSettingModel;
    }

    /**
     * Read a setting value, falling back to `fallback` when unset.
     * @param {string} application
     * @param {string} key
     * @param {*} [fallback]
     * @returns {*} The stored JSON value, or `fallback`
     */
    async getSetting(application, key, fallback = null) {
        return this.executeOperation(async () => {
            const row = await this.appSettingModel.get(application, key);
            return row ? row.value : fallback;
        });
    }

    /**
     * Write a setting value.
     * @param {string} application
     * @param {string} key
     * @param {*} value
     * @param {string} [updatedBy]
     * @returns {Object} The upserted row
     */
    async setSetting(application, key, value, updatedBy = null) {
        return this.executeOperation(async () => {
            return this.appSettingModel.set(application, key, value, updatedBy);
        });
    }

    /**
     * Whether auto-approve ("autopilot") is currently on. Unset => default (true).
     * @returns {boolean}
     */
    async getAutoApprove() {
        const value = await this.getSetting(APPLICATION, AUTO_APPROVE_KEY, AUTO_APPROVE_DEFAULT);
        // Stored as a JSON boolean; tolerate a stringified value defensively.
        return value === true || value === 'true';
    }

    /**
     * Turn auto-approve on/off.
     * @param {boolean} enabled
     * @param {string} [updatedBy] - Actor email for audit
     * @returns {boolean} The new state
     */
    async setAutoApprove(enabled, updatedBy = null) {
        const next = !!enabled;
        await this.setSetting(APPLICATION, AUTO_APPROVE_KEY, next, updatedBy);
        return next;
    }
}

SettingsService.APPLICATION = APPLICATION;
SettingsService.AUTO_APPROVE_KEY = AUTO_APPROVE_KEY;
SettingsService.AUTO_APPROVE_DEFAULT = AUTO_APPROVE_DEFAULT;

module.exports = SettingsService;
