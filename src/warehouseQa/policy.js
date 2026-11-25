const policy = Object.fromEntries(require('./policy.v0.7.json').map((r) => [r.id, r]));
const registry = Object.fromEntries(require('./registry.json').map((r) => [r.key, r]));
module.exports = { policy, registry };
