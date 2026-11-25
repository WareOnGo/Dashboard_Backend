const { policy, registry } = require('./policy');
const { blank, measured, quantityWithUnitText } = require('./normalization');

const common = new Map(policy.WAREHOUSE_QA.common_codes.map((entry) => [entry.code, entry]));
const placeholders = new Set(policy.WAREHOUSE_QA.placeholder_tokens.map((value) => value.toLowerCase()));

function displayedValue(value) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const text = (typeof value === 'string' ? value : JSON.stringify(value)) ?? 'not supplied';
  const compact = text.replace(/\s+/g, ' ').trim();
  return '“' + (compact.length > 100 ? compact.slice(0, 99) + '…' : compact) + '”';
}

// Presentation only: retain the original findings, decisions and admin notes.
// Old pilot results used MISSING_REQUIRED for both blanks and placeholders.
function reviewComment(finding, fields) {
  const rule = policy[finding.rule_id];
  if (!rule) return finding.explanation || '';
  const value = fields[finding.field_key];
  let code = finding.case_code;
  const label = registry[finding.review_field_key || finding.field_key]?.label || 'This field';
  if (
    ['MISSING_REQUIRED', 'REQUIRED_PLACEHOLDER', 'PLACEHOLDER'].includes(code) &&
    typeof value === 'string' &&
    rule.placeholder_exceptions?.some((exception) => exception.toLowerCase() === value.trim().toLowerCase())
  ) {
    return `${label} is recorded as ${displayedValue(value)}. The current SOP allows this wording; review or rerun this older flag.`;
  }
  if (
    rule.id === 'F.FLOOR_STRENGTH' &&
    code === 'LOAD_INVALID' &&
    !measured(value, rule.field_key).values &&
    quantityWithUnitText(value)?.gt(0)
  ) {
    code = 'LOAD_KG_OR_UNKNOWN';
  }
  if (code === 'MISSING_REQUIRED' && !blank(value)) {
    if (typeof value === 'string' && placeholders.has(value.trim().toLowerCase())) {
      code = 'REQUIRED_PLACEHOLDER';
    } else {
      return `${label} needs checking. Please confirm the recorded value ${displayedValue(value)}.`;
    }
  }
  // Semantic AI explanations carry the evidence-specific detail. Host cases use
  // policy-owned templates instead of pasting conditional rule specifications.
  if (finding.executor === 'AI_TEXT' && !common.has(code)) return finding.explanation || '';
  const template =
    rule.review_comments?.[code] ||
    rule.cases.find((entry) => entry.code === code)?.review_comment ||
    common.get(code)?.review_comment;
  if (!template) return finding.explanation || '';
  const replacements = {
    field: label,
    value: displayedValue(value)
  };
  return template.replace(/\{(field|value)\}/g, (_, key) => replacements[key]);
}

function candidateComment(candidate, fields) {
  const comments = [
    ...new Set(candidate.findings.map((finding) => reviewComment(finding, fields)).filter(Boolean))
  ];
  const text = comments.join('\n');
  return text.length > 500 ? text.slice(0, 499).trimEnd() + '…' : text;
}

module.exports = { reviewComment, candidateComment };
