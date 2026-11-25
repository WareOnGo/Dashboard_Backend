const { policy } = require('./policy');
const { fail } = require('./common');

const scope = policy.WAREHOUSE_QA.record_scope;
// ECMAScript trim whitespace, also used by PostgreSQL queue predicates.
const trimCharacters =
  '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const normalize = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const allowedTypes = scope.warehouse_types.map(normalize);

function exclusion(row) {
  const fields = row.fields || {};
  if (normalize(fields.isBroker) === 'yes' || normalize(fields.warehouseOwnerType) === 'broker')
    return 'SKIPPED_BROKER';
  if (!allowedTypes.includes(normalize(fields[scope.type_field]))) return scope.other_or_missing_type_status;
  return null;
}

function requireEligible(row) {
  const reason = exclusion(row);
  if (reason)
    fail(
      409,
      'QA_OUT_OF_SCOPE',
      reason === 'SKIPPED_BROKER'
        ? 'Broker listings are outside this QA policy.'
        : 'This QA policy applies only to PEB listings. This record cannot be evaluated or assigned.'
    );
}

module.exports = { scope, allowedTypes, trimCharacters, exclusion, requireEligible };
