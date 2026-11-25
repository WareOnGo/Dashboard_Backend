const engine = require('../../src/warehouseQa/engine');
function row(id = 1, overrides = {}) {
  const fields = {
    ...Object.fromEntries(Object.keys(engine.registry).map((key) => [key, null])),
    warehouseType: 'PEB',
    listing_type: 'Rent',
    ratePerSqft: '20',
    isBroker: 'No',
    clearHeightFt: '30 feet',
    centreHeight: '35 feet',
    builtup_area: '10000 sq ft',
    carpet_area: '9000 sq ft',
    insulationPresent: 'No',
    insulationType: 'None',
    'warehouseData.fireNocAvailable': false,
    ...overrides
  };
  return {
    warehouse_id: id,
    city: 'Fixture City',
    state: 'Fixture State',
    warehouse_type: 'PEB',
    fields,
    snapshot_id: 'fixture-' + id,
    source_field_versions: {},
    mode: 'BACKFILL',
    as_of_date: '2026-11-24',
    source_captured_at_utc: '2026-11-24T00:00:00Z'
  };
}
function output(request) {
  return {
    request_id: request.request_id,
    results: request.requested_checks.map((check) => {
      const rule = engine.policy[check.rule_id];
      const index = request.fields.findIndex((field) => rule.inputs.includes(field.field_key));
      const value = request.fields[index].raw_value;
      return {
        ...check,
        case_code: rule.cases.find((c) => c.verdict === 'GOOD').code,
        explanation: 'Synthetic model fixture.',
        missing_inputs: [],
        evidence: [
          {
            kind: 'FIELD',
            source_ref: `/fields/${index}/raw_value`,
            quote: typeof value === 'string' ? value : null
          }
        ]
      };
    })
  };
}
function result(snapshot) {
  const { request, host } = engine.aiRequest(snapshot, snapshot.as_of_date);
  return engine.assemble(snapshot, [...host, ...engine.acceptAi(snapshot, request, output(request))], {
    model_requested: 'gpt-6.2-sol',
    fixture: true
  });
}
module.exports = { row, output, result };
