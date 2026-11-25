const { exclusion } = require('../../src/warehouseQa/eligibility');
const engine = require('../../src/warehouseQa/engine');
const { QaInference } = require('../../src/warehouseQa/inference');
const { row, result, output } = require('../fixtures/warehouseQa');
const { importPilot } = require('../../scripts/importWarehouseQaPilot');

test.each(['RCC', 'BTS', 'Shed', 'PEB/RCC', 'Not Known', '', null, undefined])(
  'type %j cannot enter deterministic or AI evaluation',
  async (type) => {
    const snapshot = { ...row(1, { warehouseType: type }), warehouse_type: 'PEB' };
    expect(exclusion(snapshot)).toBe('SKIPPED_WAREHOUSE_TYPE');
    expect(() => engine.deterministic(snapshot)).toThrow('only to PEB');
    expect(() => engine.aiRequest(snapshot, snapshot.as_of_date)).toThrow('only to PEB');
    const repository = { cache: jest.fn() };
    const fetchImpl = jest.fn(),
      apiKey = jest.fn();
    await expect(new QaInference({ repository, fetchImpl, apiKey }).evaluate(snapshot)).rejects.toMatchObject(
      { code: 'QA_OUT_OF_SCOPE' }
    );
    expect(repository.cache).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(apiKey).not.toHaveBeenCalled();
  }
);

test.each(['PEB', 'peb', ' PEB ', '\tpeB\n', '\u00a0PEB\u00a0'])(
  'an explicit PEB type %j is eligible after trimming and case normalization',
  (type) => {
    const snapshot = row(1, { warehouseType: type });
    expect(exclusion(snapshot)).toBeNull();
    const { request } = engine.aiRequest(snapshot, snapshot.as_of_date);
    expect(request.fields.find((field) => field.field_key === 'warehouseType').raw_value).toBe(type);
  }
);

test('PEB scope does not override broker exclusions or infer a missing captured type', () => {
  expect(exclusion(row(1, { warehouseType: 'PEB', isBroker: 'Yes' }))).toBe('SKIPPED_BROKER');
  const snapshot = row();
  delete snapshot.fields.warehouseType;
  snapshot.warehouse_type = 'PEB';
  expect(exclusion(snapshot)).toBe('SKIPPED_WAREHOUSE_TYPE');
});

test('historical non-PEB artifacts can still be validated for import without running new QA', async () => {
  const original = row(2);
  const historical = result(original);
  const { request } = engine.aiRequest(original, original.as_of_date);
  request.fields.find((field) => field.field_key === 'warehouseType').raw_value = 'RCC';
  request.fields.find((field) => field.field_key === 'warehouseType').normalized_value = 'RCC';
  const snapshot = row(2, { warehouseType: 'RCC' });
  historical.fields = snapshot.fields;
  const imported = await importPilot(
    {},
    {
      runs: [{ id: 'historical-run', data: {} }],
      items: [
        {
          run_id: 'historical-run',
          snapshot,
          result: historical,
          artifact: { request, raw_output: output(request) }
        }
      ],
      events: [],
      requests: []
    }
  );
  expect(imported).toMatchObject({ mode: 'dry-run', warehouses: 1 });
  expect(() => engine.deterministic(snapshot)).toThrow('only to PEB');
});
