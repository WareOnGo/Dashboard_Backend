const { createHash } = require('node:crypto');
class QaError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => {
  throw new QaError(status, code, message);
};
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])])
        )
      : value;
const hash = (value) =>
  createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
module.exports = { QaError, fail, hash, clone };
