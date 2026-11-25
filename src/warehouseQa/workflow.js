const { randomUUID } = require('node:crypto');
const { registry } = require('./engine');
const { fail } = require('./common');
const { reasons } = require('./contracts');
const { candidateComment } = require('./reviewComments');
const { requireEligible } = require('./eligibility');
const conflict = (message) => fail(409, 'QA_REVIEW_CONFLICT', message);
const invalid = (message) => fail(400, 'QA_INVALID_REVIEW', message);

function adjudicate(candidate, body, stamp) {
  if (body.decision === 'REJECTED' && (!reasons.includes(body.reason) || !body.note))
    invalid('A rejection reason and note are required.');
  Object.assign(candidate, stamp, {
    decision: body.decision,
    admin_note: body.note,
    decision_reason: body.decision === 'REJECTED' ? body.reason : null,
    version: candidate.version + 1
  });
}

function humanFlag(row, body, stamp, version = 0) {
  if (!registry[body.field_key] || !Object.hasOwn(row.fields, body.field_key))
    invalid('Column is not in this snapshot.');
  if (
    body.missed_rule_id &&
    !row.checks.some(
      (check) =>
        check.review_field_key === body.field_key &&
        check.rule_id === body.missed_rule_id &&
        check.verdict === 'GOOD'
    )
  )
    invalid('A miss must identify a specific passed check for this column.');
  return {
    ...stamp,
    field_key: body.field_key,
    label: registry[body.field_key].label,
    value: row.fields[body.field_key],
    source: 'ADMIN',
    decision: 'APPROVED',
    admin_note: body.note,
    decision_reason: null,
    findings: [],
    version,
    missed_rule_id: body.missed_rule_id || null,
    evaluation_label: body.missed_rule_id ? 'ADMIN_FOUND_MISS' : 'COVERAGE_GAP'
  };
}

// A form confirmation is one warehouse transaction and one audit event. Require
// every machine candidate so a stale or incomplete form cannot silently omit one.
function applyReview(row, review, stamp) {
  const machine = row.candidates.filter((candidate) => candidate.source === 'MACHINE');
  const keys = [...review.machine, ...review.human].map((item) => item.field_key);
  if (new Set(keys).size !== keys.length) invalid('Review fields must be unique.');
  if (
    review.machine.length !== machine.length ||
    machine.some((candidate) => !review.machine.some((item) => item.field_key === candidate.field_key))
  )
    invalid('Include a decision for every AI-proposed field.');
  for (const candidate of machine)
    adjudicate(
      candidate,
      review.machine.find((item) => item.field_key === candidate.field_key),
      stamp
    );
  const human = review.human.map((item) =>
    humanFlag(
      row,
      item,
      stamp,
      (row.candidates.find((candidate) => candidate.field_key === item.field_key)?.version ?? -1) + 1
    )
  );
  row.candidates = [...machine, ...human];
  for (const item of human) delete row.clean_reviews[item.field_key];
}

function applyDecision(row, operation, body, actor, { assignees = [] } = {}) {
  requireEligible(row);
  if (row.version !== body.expected_version) conflict('Review changed. Refresh before deciding.');
  if (row.stage !== 'AI_REVIEW') conflict('This adjudication is already confirmed.');
  const at = new Date().toISOString();
  const stamp = { adjudicated_by: actor.name, adjudicated_at: at };
  const candidate = row.candidates.find((c) => c.field_key === body.field_key);
  switch (operation) {
    case 'decision': {
      if (!candidate || candidate.source !== 'MACHINE') invalid('Select a machine-proposed column.');
      adjudicate(candidate, body, stamp);
      break;
    }
    case 'admin-flags': {
      if (candidate) conflict('This column already has a flag. Use its notes and decision.');
      row.candidates.push(humanFlag(row, body, stamp));
      delete row.clean_reviews[body.field_key];
      break;
    }
    case 'remove-admin-flag':
      if (!candidate || candidate.source !== 'ADMIN') invalid('Admin-added flag not found.');
      row.candidates = row.candidates.filter((c) => c !== candidate);
      break;
    case 'review-clean': {
      if (!Object.hasOwn(row.fields, body.field_key) || candidate)
        invalid('Select an unflagged snapshot column.');
      const checks = row.checks.filter((c) => c.review_field_key === body.field_key);
      const covered =
        checks.some((c) => c.verdict === 'GOOD') &&
        checks.every((c) => ['GOOD', 'NOT_APPLICABLE'].includes(c.verdict));
      row.clean_reviews[body.field_key] = {
        label: 'CONFIRMED_CLEAN',
        covered,
        actor: actor.name,
        note: body.note,
        at
      };
      break;
    }
    case 'confirm': {
      if (row.coverage.ai_status !== 'COMPLETED')
        conflict('Complete AI checks before confirming this warehouse.');
      if (body.review) applyReview(row, body.review, stamp);
      if (row.candidates.some((c) => c.decision === 'PENDING'))
        conflict('Approve or reject every proposed column before confirming.');
      const approved = row.candidates.filter((c) => c.decision === 'APPROVED');
      if (!approved.length) {
        row.stage = 'DISMISSED';
        break;
      }
      const assignee = assignees.find((a) => a.id === body.assignee_id);
      if (!assignee) invalid('Choose an active employee who can view this warehouse.');
      row.handoff = {
        status: 'STAGED_LOCAL_ONLY',
        assignee,
        payload: {
          requestId: randomUUID(),
          warehouseId: row.warehouse_id,
          assigneeId: assignee.id,
          fields: approved.map((c) => ({
            key: c.field_key,
            comment: (c.admin_note || candidateComment(c, row.fields)).slice(0, 500)
          }))
        },
        existing_endpoint: 'POST /api/field-reviews',
        production_request_sent: false,
        approved_sources: Object.fromEntries(approved.map((c) => [c.field_key, c.source])),
        source_snapshot_id: row.snapshot_id,
        confirmed_by: actor.name,
        confirmed_at: at
      };
      row.stage = 'ASSIGNED_LOCAL';
      break;
    }
    default:
      invalid('Unknown review operation.');
  }
  row.version += 1;
  row.last_modified_at = at;
  return row;
}

function metrics(rows) {
  const machine = rows.flatMap((r) => r.candidates.filter((c) => c.source === 'MACHINE'));
  const manual = rows.flatMap((r) => r.candidates.filter((c) => c.source === 'ADMIN'));
  const accepted = machine.filter((c) => c.decision === 'APPROVED').length;
  const incorrect = machine.filter(
    (c) => c.decision === 'REJECTED' && c.decision_reason === 'INCORRECT'
  ).length;
  const missed = manual.filter((c) => c.evaluation_label === 'ADMIN_FOUND_MISS').length;
  return {
    machine_columns: machine.length,
    pending: machine.filter((c) => c.decision === 'PENDING').length,
    accepted,
    rejected_incorrect: incorrect,
    rejected_other: machine.filter((c) => c.decision === 'REJECTED' && c.decision_reason !== 'INCORRECT')
      .length,
    admin_found_misses: missed,
    coverage_gaps: manual.length - missed,
    reviewed_clean_columns: rows.flatMap((r) => Object.values(r.clean_reviews || {})).filter((c) => c.covered)
      .length,
    reviewed_precision: accepted + incorrect ? accepted / (accepted + incorrect) : null,
    reviewed_recall: accepted + missed ? accepted / (accepted + missed) : null,
    limitations:
      'Admin agreement on reviewed columns only. This selected corpus is not a population accuracy benchmark. Unreviewed and unevaluated columns are never true negatives.'
  };
}
module.exports = { applyDecision, metrics };
