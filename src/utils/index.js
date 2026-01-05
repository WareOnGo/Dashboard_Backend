const { config, validateAuthConfig, getConfig, getAuthConfig } = require('./config');
const constants = require('./constants');
const database = require('./database');
const s3Client = require('./s3Client');

module.exports = {
  // Configuration utilities
  config,
  validateAuthConfig,
  getConfig,
  getAuthConfig,
  
  // Existing utilities
  constants,
  database,
  s3Client
};