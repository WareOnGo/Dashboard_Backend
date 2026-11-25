const { candidateComment } = require('../../src/warehouseQa/reviewComments');
const { QaService } = require('../../src/warehouseQa/service');
const { policy, profile } = require('../../src/warehouseQa/engine');

function legacy(value, note = '') {
  return {
    fields: { flooringType: value },
    coverage: {},
    checks: [],
    candidates: [
      {
        field_key: 'flooringType',
        label: 'Flooring Type',
        source: 'MACHINE',
        admin_note: note,
        findings: [
          {
            rule_id: 'F.FLOORING',
            field_key: 'flooringType',
            review_field_key: 'flooringType',
            case_code: 'MISSING_REQUIRED',
            executor: 'CODE',
            explanation: 'A required answer is blank or is an exact placeholder.'
          }
        ]
      }
    ]
  };
}

test.each([
  [null, 'Flooring Type is missing. Please add it.'],
  ['NA', 'Flooring Type is recorded as “NA”. Please replace this placeholder with the actual details.'],
  ['-', 'Flooring Type is recorded as “-”. Please replace this placeholder with the actual details.']
])('renders legacy presence findings precisely from their captured value %j', (value, expected) => {
  const result = legacy(value);
  const before = structuredClone(result);
  expect(candidateComment(result.candidates[0], result.fields)).toBe(expected);
  expect(result).toEqual(before);
});

test('read responses suggest clearer comments without rewriting saved findings or admin notes', async () => {
  const result = legacy('N/A', 'My existing review note.');
  const before = structuredClone(result);
  const service = new QaService({
    repository: {
      item: async () => ({ result, runId: 'legacy', snapshot: {}, createdAt: new Date('2026-11-24') }),
      events: async () => [],
      run: async () => ({ metadata: {} })
    }
  });
  const response = await service.detail('legacy', 914);
  expect(response.candidates[0].suggested_note).toContain('recorded as “N/A”');
  expect(response.candidates[0].admin_note).toBe('My existing review note.');
  expect(response.candidates[0].findings).toEqual(result.candidates[0].findings);
  expect(result).toEqual(before);
});

test('legacy floor-strength notes ask about the unknown unit without rewriting the old verdict', () => {
  const fields = { floorStrengthPerSqm: '5 mtr/sqm' };
  const candidate = {
    findings: [
      {
        rule_id: 'F.FLOOR_STRENGTH',
        field_key: 'floorStrengthPerSqm',
        case_code: 'LOAD_INVALID',
        verdict: 'BAD',
        executor: 'CODE',
        explanation: 'A numeric quantity is invalid.'
      }
    ]
  };
  const before = structuredClone(candidate);
  expect(candidateComment(candidate, fields)).toContain('unit');
  expect(candidateComment(candidate, fields)).not.toMatch(/zero|negative|invalid/);
  expect(candidate).toEqual(before);
});

test('an older flag does not call newly approved conditional fire wording a placeholder', () => {
  const fields = { 'warehouseData.fireSafetyMeasures': 'As per requirement' };
  const candidate = {
    findings: [
      {
        rule_id: 'F.FIRE_MEASURES',
        field_key: 'warehouseData.fireSafetyMeasures',
        case_code: 'MISSING_REQUIRED',
        verdict: 'BAD',
        executor: 'CODE'
      }
    ]
  };
  const before = structuredClone(candidate);
  expect(candidateComment(candidate, fields)).toContain('current SOP allows this wording');
  expect(candidateComment(candidate, fields)).not.toMatch(/is missing|replace this placeholder/i);
  expect(candidate).toEqual(before);
});

test('all deterministic issue cases have a reviewer-facing comment instead of rule text', () => {
  for (const id of profile.code_rules) {
    for (const item of policy[id].cases.filter((c) => ['BAD', 'REVIEW'].includes(c.verdict))) {
      expect({ id, code: item.code, hasComment: !!item.review_comment }).toEqual({
        id,
        code: item.code,
        hasComment: true
      });
    }
  }
});
