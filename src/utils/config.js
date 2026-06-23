const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

/**
 * Application configuration object
 * Validates and provides access to environment variables
 */
const config = {
  // Server configuration
  server: {
    port: process.env.PORT || 3001,
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000'
  },

  // Google OAuth configuration
  oauth: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/auth/google/callback'
    }
  },

  // JWT configuration
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '24h'
  },

  // Domain restriction configuration
  auth: {
    allowedDomain: process.env.ALLOWED_DOMAIN || 'wareongo.com'
  },

  // Database configuration
  database: {
    url: process.env.DATABASE_URL
  },

  // Existing configurations
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN
  },

  r2: {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucketName: process.env.R2_BUCKET_NAME,
    publicUrl: process.env.R2_PUBLIC_URL
  },

  // Gupshup WhatsApp — review-outcome notifications to the employee who submitted.
  // OFF by default: only flip GUPSHUP_ENABLED=true once the review flow goes live.
  // See src/services/gupshupService.js.
  gupshup: {
    // Master kill-switch. Anything other than the string 'true' keeps it off.
    enabled: process.env.GUPSHUP_ENABLED === 'true',
    apiKey: process.env.GUPSHUP_API_KEY,
    endpoint: process.env.GUPSHUP_ENDPOINT || 'https://api.gupshup.io/wa/api/v1/template/msg',
    source: process.env.GUPSHUP_SOURCE,            // registered WABA phone in E.164 form
    srcName: process.env.GUPSHUP_SRC_NAME,         // Gupshup app name
    templateId: process.env.GUPSHUP_TEMPLATE_ID,   // approved utility template id
    // Fixed comment sent on approvals (approvals carry no reviewer note today).
    approveComment: process.env.GUPSHUP_APPROVE_COMMENT || 'Approved, your submission is now live.'
  }
};

/**
 * Validates required environment variables for authentication
 * @throws {Error} If required variables are missing
 */
function validateAuthConfig() {
  const requiredVars = [
    { key: 'GOOGLE_CLIENT_ID', value: config.oauth.google.clientId },
    { key: 'GOOGLE_CLIENT_SECRET', value: config.oauth.google.clientSecret },
    { key: 'JWT_SECRET', value: config.jwt.secret },
    { key: 'ALLOWED_DOMAIN', value: config.auth.allowedDomain }
  ];

  const missingVars = requiredVars.filter(({ value }) => !value);

  if (missingVars.length > 0) {
    const missing = missingVars.map(({ key }) => key).join(', ');
    throw new Error(`Missing required environment variables: ${missing}`);
  }

  // Validate JWT secret strength (minimum 32 characters)
  if (config.jwt.secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters long for security');
  }

  // Validate domain format
  if (!config.auth.allowedDomain.includes('.')) {
    throw new Error('ALLOWED_DOMAIN must be a valid domain format (e.g., wareongo.com)');
  }
}

/**
 * Gets the complete configuration object
 * @returns {Object} Configuration object
 */
function getConfig() {
  return config;
}

/**
 * Gets authentication-specific configuration
 * @returns {Object} Auth configuration
 */
function getAuthConfig() {
  return {
    oauth: config.oauth,
    jwt: config.jwt,
    auth: config.auth,
    server: config.server
  };
}

module.exports = {
  config,
  validateAuthConfig,
  getConfig,
  getAuthConfig
};