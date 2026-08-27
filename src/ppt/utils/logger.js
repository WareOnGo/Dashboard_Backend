/**
 * Structured logging utility for warehouse PPT generation
 * Provides consistent log formatting with timestamps, levels, and context
 */

const LOG_LEVELS = {
  ERROR: 'ERROR',
  WARN: 'WARN',
  INFO: 'INFO',
  DEBUG: 'DEBUG'
};

/**
 * Format and output a structured log message
 * @param {string} level - Log level (ERROR, WARN, INFO, DEBUG)
 * @param {string} component - Component/service name
 * @param {string} functionName - Function name where log originated
 * @param {string} message - Log message
 * @param {Object} details - Additional context (warehouseId, error details, etc.)
 */
function log(level, component, functionName, message, details = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    component,
    function: functionName,
    message,
    ...details
  };

  const logString = JSON.stringify(logEntry);

  switch (level) {
    case LOG_LEVELS.ERROR:
      console.error(logString);
      break;
    case LOG_LEVELS.WARN:
      console.warn(logString);
      break;
    case LOG_LEVELS.INFO:
      console.info(logString);
      break;
    case LOG_LEVELS.DEBUG:
      console.debug(logString);
      break;
    default:
      console.log(logString);
  }
}

/**
 * Log an error with structured format
 */
function logError(component, functionName, message, details = {}) {
  log(LOG_LEVELS.ERROR, component, functionName, message, details);
}

/**
 * Log a warning with structured format
 */
function logWarn(component, functionName, message, details = {}) {
  log(LOG_LEVELS.WARN, component, functionName, message, details);
}

/**
 * Log an info message with structured format
 */
function logInfo(component, functionName, message, details = {}) {
  log(LOG_LEVELS.INFO, component, functionName, message, details);
}

/**
 * Log a debug message with structured format
 */
function logDebug(component, functionName, message, details = {}) {
  // Only log debug messages if DEBUG environment variable is set
  if (process.env.DEBUG) {
    log(LOG_LEVELS.DEBUG, component, functionName, message, details);
  }
}

module.exports = {
  logError,
  logWarn,
  logInfo,
  logDebug,
  LOG_LEVELS
};
