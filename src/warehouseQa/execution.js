const fs = require('node:fs');
const path = require('node:path');
const engine = require('./engine');
const { hash } = require('./common');
const { settings } = require('./modelConfig');

// A persisted execution identity fences rolling deployments, including code-only
// changes that do not alter the SOP version. No model response selects this policy.
const execution = Object.freeze({
  version: 1,
  profile_hash: engine.profileHash,
  policy_version: engine.profile.policy_version,
  registry_hash: hash(engine.registry),
  engine_hash: hash(
    ['engine.js', 'normalization.js', 'eligibility.js', 'reviewComments.js', 'inference.js'].map((file) =>
      fs.readFileSync(path.join(__dirname, file), 'utf8')
    )
  ),
  schema_hash: hash(engine.policy['MODEL_OUTPUT.V1']),
  settings
});
const executionHash = hash(execution);

function blockedResult(snapshot, metadata = {}) {
  return {
    ...snapshot,
    checks: [],
    candidates: [],
    version: 0,
    stage: 'AI_REVIEW',
    clean_reviews: {},
    handoff: null,
    model: { error: 'QA_EXECUTION_CHANGED', enqueued_execution: metadata.execution || null },
    coverage: {
      profile: metadata.profile?.id || null,
      evaluation_status: 'NOT_EVALUATED',
      ai_status: 'POLICY_CHANGED',
      planned_checks: 0,
      not_evaluated: 0,
      sop_coverage: 'PARTIAL_PROFILE',
      deferred: metadata.profile?.deferred || []
    }
  };
}

module.exports = { execution, executionHash, blockedResult };
