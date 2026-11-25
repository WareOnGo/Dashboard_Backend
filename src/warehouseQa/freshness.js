const { hash } = require('./common');
const { policy, registry } = require('./engine');
const { exclusion } = require('./eligibility');

function changedFields(before, after, keys = Object.keys(registry)) {
  return keys.filter(
    (key) =>
      hash(before.fields[key] ?? null) !== hash(after.fields[key] ?? null) ||
      (before.source_field_versions?.[key] || 0) !== (after.source_field_versions?.[key] || 0)
  );
}

function reviewDependencies(result) {
  const keys = new Set(['warehouseType', 'isBroker', 'warehouseOwnerType']);
  for (const candidate of result.candidates.filter((item) => item.decision === 'APPROVED')) {
    keys.add(candidate.field_key);
    for (const finding of candidate.findings) {
      // Unknown historical rules must not silently lose their evidence dependencies.
      for (const key of policy[finding.rule_id]?.inputs || Object.keys(registry)) keys.add(key);
    }
    if (candidate.source === 'ADMIN') {
      // Free-form human notes can refer to any visible QA field.
      for (const key of Object.keys(registry)) keys.add(key);
    }
  }
  return [...keys];
}

function freshness(before, current, reviewed) {
  if (!current) return { current: false, reason: 'SOURCE_DELETED', changed_fields: [] };
  const reason = exclusion(current);
  const changed = changedFields(before, current, reviewDependencies(reviewed));
  return {
    current: !reason && changed.length === 0,
    reason: reason || (changed.length ? 'SOURCE_CHANGED' : null),
    changed_fields: changed
  };
}

module.exports = { freshness, changedFields, reviewDependencies };
