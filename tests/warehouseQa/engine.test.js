const engine = require('../../src/warehouseQa/engine');
const { row, output } = require('../fixtures/warehouseQa');
const { QaInference } = require('../../src/warehouseQa/inference');

test.each(['5', '250', '10000', '0'])('bare power %s never acquires a guessed unit', (value) => {
  const snapshot = row(1, { 'warehouseData.powerKva': value });
  expect(engine.fieldCase(snapshot, engine.policy['F.POWER'])).toBe('POWER_UNIT_UNRESOLVED');
});
test('unit conversions use exact decimal boundaries and preserve raw inputs', () => {
  const snapshot = row(1, {
    clearHeightFt: '9.144 metres',
    centreHeight: '30 feet',
    distance_from_highway: '1500 m',
    'warehouseData.powerKva': '50 HP'
  });
  expect(engine.normalized(snapshot.fields.clearHeightFt, 'clearHeightFt')[0].toString()).toBe('30');
  expect(engine.normalized('1500 m', 'distance_from_highway')[0].toString()).toBe('1.5');
  expect(engine.deterministic(snapshot).find((c) => c.rule_id === 'X.HEIGHT_ORDER').case_code).toBe(
    'HEIGHT_ORDER_OK'
  );
  expect(snapshot.fields['warehouseData.powerKva']).toBe('50 HP');
  expect(engine.measured('500', 'distance_from_highway').unit).toBeNull();
});
test.each([
  ['F.POWER', 'warehouseData.powerKva', '12 watts', 'POWER_UNIT_UNSUPPORTED'],
  ['F.HIGHWAY_DISTANCE', 'distance_from_highway', '100 feet', 'HIGHWAY_DISTANCE_UNIT_UNSUPPORTED'],
  ['F.LIFT_CAPACITY', 'liftLoadCapacity', '12 lbs', 'LIFT_CAPACITY_UNIT_UNSUPPORTED'],
  ['F.FLOOR_STRENGTH', 'floorStrengthPerSqm', '5T', 'LOAD_OK']
])('resolves %s without treating an unsupported unit as valid', (rule, field, value, expected) => {
  expect(engine.fieldCase(row(1, { [field]: value }), engine.policy[rule])).toBe(expected);
});

test.each([
  ['5 mtr/sqm', 'LOAD_KG_OR_UNKNOWN'],
  ['6 mtr/sqm', 'LOAD_KG_OR_UNKNOWN'],
  ['5 kg/m2', 'LOAD_KG_OR_UNKNOWN'],
  ['5 kg/sq m', 'LOAD_KG_OR_UNKNOWN'],
  ['5 MT/sqm', 'LOAD_OK'],
  ['0 mtr/sqm', 'LOAD_INVALID'],
  ['-2 kg/sqm', 'LOAD_INVALID'],
  ['5 x 6 mtr/sqm', 'LOAD_INVALID'],
  ['mtr/sqm', 'LOAD_INVALID'],
  ['Infinity tonnes/sq m', 'LOAD_INVALID']
])('separates floor-strength quantity failures from unclear units: %s', (value, expected) => {
  const snapshot = row(914, { floorStrengthPerSqm: value });
  const actual = engine.deterministic(snapshot).find((check) => check.rule_id === 'F.FLOOR_STRENGTH');
  expect(actual.case_code).toBe(expected);
  if (expected === 'LOAD_KG_OR_UNKNOWN') {
    expect(actual.verdict).toBe('REVIEW');
    expect(actual.explanation).toContain('unit');
    expect(actual.explanation).not.toMatch(/zero|negative|nonfinite/);
  }
  expect(snapshot.fields.floorStrengthPerSqm).toBe(value);
});

test.each([
  [null, 'MISSING_REQUIRED', 'Flooring Type is missing'],
  ['', 'MISSING_REQUIRED', 'Flooring Type is missing'],
  ['  ', 'MISSING_REQUIRED', 'Flooring Type is missing'],
  ['N/A', 'REQUIRED_PLACEHOLDER', 'recorded as “N/A”'],
  ['-', 'REQUIRED_PLACEHOLDER', 'recorded as “-”']
])('distinguishes a blank required answer from a supplied placeholder: %j', (value, code, note) => {
  const actual = engine
    .deterministic(row(1, { flooringType: value }))
    .find((check) => check.rule_id === 'F.FLOORING');
  expect(actual.case_code).toBe(code);
  expect(actual.explanation).toContain(note);
  expect(actual.explanation).not.toContain('blank or');
});

test.each(['As per requirement', 'APCR', '  as PER requirement  '])(
  'host accepts conditional fire provision %s without a missing-answer or AI guess',
  (value) => {
    const snapshot = row(914, {
      'warehouseData.fireSafetyMeasures': value,
      compliances: 'CLU, Fire NOC as per requirement',
      fire_compliance_cert_type: 'Fire NOC'
    });
    const { host, request, prompt } = engine.aiRequest(snapshot, snapshot.as_of_date);
    expect(host.find((check) => check.rule_id === 'F.FIRE_MEASURES')).toMatchObject({
      case_code: 'FIRE_MEASURES_ON_REQUEST',
      verdict: 'GOOD',
      executor: 'CODE'
    });
    expect(request.requested_checks.some((check) => check.rule_id === 'F.FIRE_MEASURES')).toBe(false);
    expect(
      request.fields.find((field) => field.field_key === 'warehouseData.fireSafetyMeasures').raw_value
    ).toBe(value);
    expect(prompt).toContain('bare certificate type Fire NOC is consistent');
    expect(snapshot.fields['warehouseData.fireNocAvailable']).toBe(false);
    expect(engine.fieldCase(row(1, { flooringType: value }), engine.policy['F.FLOORING'])).not.toBe(
      'OPTIONAL_BLANK'
    );
  }
);

test('accepted fire wording is a scoped exception, and false/zero remain real answers', () => {
  expect(engine.fieldCase(row(1, { flooringType: 'As per requirement' }), engine.policy['F.FLOORING'])).toBe(
    'REQUIRED_PLACEHOLDER'
  );
  expect(
    engine.fieldCase(row(1, { 'warehouseData.fireNocAvailable': false }), engine.policy['F.FIRE_NOC'])
  ).toBe('FIRE_BOOLEAN_OK');
  expect(engine.fieldCase(row(1, { numberOfDocks: 0 }), engine.policy['F.DOCK_COUNT'])).toBe('DOCK_OK');
});
test('rechecks with unknown provenance retain legacy format leniency', () => {
  const snapshot = { ...row(1, { totalFloors: 'ground and first' }), mode: 'RECHECK' };
  const check = (value) => engine.deterministic(value).find((result) => result.rule_id === 'F.TOTAL_FLOORS');
  expect(check(snapshot).verdict).toBe('REVIEW');
  expect(check({ ...snapshot, field_provenance: { totalFloors: 'NEW_VALUE' } }).verdict).toBe('BAD');
});
test('AI cannot replace semantic checks with fabricated host presence verdicts', () => {
  const snapshot = row();
  const { request } = engine.aiRequest(snapshot, snapshot.as_of_date);
  const response = output(request);
  response.results[0].case_code = 'OPTIONAL_BLANK';
  expect(() => engine.acceptAi(snapshot, request, response)).toThrow('Host preflight');
});
test('backfill format leniency does not apply to new submissions', () => {
  const legacy = row(1, { totalFloors: 'ground and first' });
  const pick = (snapshot) => engine.deterministic(snapshot).find((c) => c.rule_id === 'F.TOTAL_FLOORS');
  expect(pick(legacy).verdict).toBe('REVIEW');
  expect(pick({ ...legacy, mode: 'NEW_SUBMISSION' }).verdict).toBe('BAD');
});
test('partial profile explicitly covers 57 checks and never labels deferred fields clean', () => {
  const snapshot = row();
  const { request, host } = engine.aiRequest(snapshot, snapshot.as_of_date);
  const result = engine.assemble(
    snapshot,
    [...host, ...engine.acceptAi(snapshot, request, output(request))],
    {}
  );
  expect(result.checks).toHaveLength(57);
  expect(result.coverage.sop_coverage).toBe('PARTIAL_PROFILE');
  expect(result.checks.some((c) => c.field_key === 'land_parcel_size')).toBe(false);
});
test.each(['duplicate', 'omitted', 'wrong request', 'wrong case', 'false quote', 'extra property'])(
  'rejects malformed AI output: %s',
  (defect) => {
    const snapshot = row();
    const { request } = engine.aiRequest(snapshot, snapshot.as_of_date);
    const response = output(request);
    if (defect === 'duplicate') response.results.push(response.results[0]);
    if (defect === 'omitted') response.results.pop();
    if (defect === 'wrong request') response.request_id = 'other';
    if (defect === 'wrong case') response.results[0].case_code = 'POWER_OK';
    if (defect === 'false quote') response.results[0].evidence[0].quote = 'invented';
    if (defect === 'extra property') response.results[0].severity = 'BAD';
    expect(() => engine.acceptAi(snapshot, request, response)).toThrow();
  }
);
test('native OpenAI client uses strict output, caches validated results, and never enables tools/storage', async () => {
  const cache = new Map();
  const repository = {
    cache: async (key) => cache.get(key),
    putCache: async (key, value) => cache.set(key, value)
  };
  const fetchImpl = jest.fn(async (_url, options) => {
    const body = JSON.parse(options.body);
    expect(body.store).toBe(false);
    expect(body.tools).toBeUndefined();
    expect(body.text.format.strict).toBe(true);
    expect(body.model).toBe('gpt-6.2-sol');
    const request = JSON.parse(body.input[1].content);
    return {
      ok: true,
      json: async () => ({
        id: 'fixture-response',
        model: 'gpt-6.2-sol',
        status: 'completed',
        usage: {},
        output: [{ content: [{ type: 'output_text', text: JSON.stringify(output(request)) }] }]
      })
    };
  });
  const inference = new QaInference({ repository, fetchImpl, apiKey: () => 'fixture' });
  const first = await inference.evaluate(row());
  const second = await inference.evaluate(row());
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(first.result.model.cache_hit).toBe(false);
  expect(second.result.model.cache_hit).toBe(true);
  expect(second.result.checks).toHaveLength(57);
});
