const { fields } = require('../../src/fieldReview/fields');
const { policy, registry, profile } = require('../../src/warehouseQa/engine');
const { check } = require('../../scripts/checkWarehouseQaPolicy');
const { row } = require('../fixtures/warehouseQa');
const { QaInference } = require('../../src/warehouseQa/inference');

test('QA field keys remain compatible with the existing manual review contract', () => {
  const manual = new Map(fields.map((field) => [field.key, field]));
  for (const field of Object.values(registry)) {
    expect(manual.get(field.key)).toBeDefined();
    expect(manual.get(field.key).sensitive).not.toBe(true);
  }
  for (const id of [...profile.code_rules, ...profile.ai_rules]) {
    expect(policy[id]).toBeDefined();
    for (const key of policy[id].field_keys || [policy[id].field_key])
      expect(registry[policy[id].review_field_key || key]).toBeDefined();
  }
});
test('policy checker detects source drift and duplicate IDs', () => {
  const records = Object.values(policy);
  const markdown = records.map((record) => '```json\n' + JSON.stringify(record) + '\n```').join('\n');
  expect(check(markdown).matched).toBe(true);
  expect(() =>
    check(markdown.replace(`"version":"${policy.WAREHOUSE_QA.version}"`, '"version":"changed"'))
  ).toThrow('differs');
  expect(() => check(markdown + '\n```json\n' + JSON.stringify(records[0]) + '\n```')).toThrow('Duplicate');
});
test('a cache entry for a different input cannot supply accepted judgments', async () => {
  const inference = new QaInference({
    repository: { cache: async () => ({ validated: true, fingerprint: 'wrong', request: {} }) },
    apiKey: () => 'fixture',
    fetchImpl: jest.fn()
  });
  await expect(inference.evaluate(row())).rejects.toMatchObject({ code: 'QA_CACHE_MISMATCH' });
});

test('all published examples in the implemented deterministic profile match the SOP', () => {
  const engine = require('../../src/warehouseQa/engine');
  let count = 0;
  for (const id of profile.code_rules) {
    const rule = policy[id];
    if (!rule.field_key) continue;
    for (const example of rule.examples || []) {
      if (!Object.hasOwn(example, 'input')) continue;
      const dependencies = Object.fromEntries(Object.entries(example).filter(([key]) => key in registry));
      const snapshot = {
        ...row(1, { [rule.field_key]: example.input, ...dependencies }),
        mode: example.mode || 'BACKFILL'
      };
      const actual = engine
        .deterministic(snapshot)
        .find((check) => check.rule_id === id && check.field_key === rule.field_key);
      expect({ rule: id, code: actual.case_code }).toEqual({ rule: id, code: example.expected_code });
      if (example.expected_verdict) expect(actual.verdict).toBe(example.expected_verdict);
      count++;
    }
  }
  expect(count).toBeGreaterThan(0);
});

test('the structured NOC example includes every declared dependency and valid evidence', () => {
  const engine = require('../../src/warehouseQa/engine');
  const example = policy['EXAMPLE.NOC_NEGATION'];
  const supplied = example.input.fields.map((field) => field.field_key);
  for (const check of example.input.requested_checks)
    expect(supplied).toEqual(expect.arrayContaining(policy[check.rule_id].inputs));
  const snapshot = row(
    4821,
    Object.fromEntries(example.input.fields.map((field) => [field.field_key, field.raw_value]))
  );
  expect(engine.acceptAi(snapshot, example.input, example.expected_output)[0].verdict).toBe('GOOD');
});
