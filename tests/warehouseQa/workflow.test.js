const { applyDecision, metrics } = require('../../src/warehouseQa/workflow');
const { exclusion, snapshot, select } = require('../../src/warehouseQa/source');
const { row, result } = require('../fixtures/warehouseQa');
const actor = { id: 'fixture', name: 'Admin fixture' };
const { mutations } = require('../../src/warehouseQa/contracts');
const action = (current, operation, data) =>
  applyDecision(current, operation, { expected_version: current.version, ...data }, actor, {
    assignees: [{ id: 1, name: 'Fixture assignee' }]
  });

test('only incorrect rejections count as false positives; uncovered columns are never clean by default', () => {
  const current = result(row());
  action(current, 'decision', {
    field_key: current.candidates[0].field_key,
    decision: 'REJECTED',
    reason: 'DUPLICATE',
    note: 'Existing flag.'
  });
  action(current, 'decision', {
    field_key: current.candidates[1].field_key,
    decision: 'REJECTED',
    reason: 'INCORRECT',
    note: 'Confirmed valid.'
  });
  action(current, 'review-clean', { field_key: 'land_parcel_size', note: 'Human inspected the value.' });
  expect(metrics([current])).toMatchObject({
    rejected_incorrect: 1,
    rejected_other: 1,
    reviewed_clean_columns: 0
  });
});
test('admin misses must identify a passed check on the same column', () => {
  const current = result(row());
  expect(() =>
    action(current, 'admin-flags', {
      field_key: 'land_parcel_size',
      note: 'Confirm area.',
      missed_rule_id: 'F.CLEAR_HEIGHT'
    })
  ).toThrow();
  action(current, 'admin-flags', {
    field_key: 'clearHeightFt',
    note: 'Owner clarified a different clear height.',
    missed_rule_id: 'F.CLEAR_HEIGHT'
  });
  action(current, 'admin-flags', { field_key: 'land_parcel_size', note: 'Confirm land area.' });
  expect(metrics([current])).toMatchObject({ admin_found_misses: 1, coverage_gaps: 1 });
  expect(current.candidates.find((candidate) => candidate.field_key === 'clearHeightFt').source).toBe(
    'ADMIN'
  );
});
test('confirmation requires all decisions and stages only approved fields', () => {
  const current = result(row());
  expect(() => action(current, 'confirm', { assignee_id: 1 })).toThrow();
  const chosen = current.candidates[0].field_key;
  for (const candidate of current.candidates)
    action(current, 'decision', {
      field_key: candidate.field_key,
      decision: candidate.field_key === chosen ? 'APPROVED' : 'REJECTED',
      reason: 'INCORRECT',
      note: 'Reviewed.'
    });
  expect(() => action(current, 'confirm', { assignee_id: 99 })).toThrow();
  action(current, 'confirm', { assignee_id: 1 });
  expect(current.stage).toBe('ASSIGNED_LOCAL');
  expect(current.handoff.production_request_sent).toBe(false);
  expect(current.handoff.payload.fields.map((field) => field.key)).toEqual([chosen]);
  expect(() => action(current, 'decision', { field_key: chosen, decision: 'PENDING', note: '' })).toThrow();
});

test('form confirmation requires complete, distinct decisions and explicit rejection explanations', () => {
  const current = result(row());
  const review = {
    machine: current.candidates.map((candidate) => ({
      field_key: candidate.field_key,
      decision: 'APPROVED',
      note: 'Review this field.'
    })),
    human: []
  };
  expect(() =>
    action(structuredClone(current), 'confirm', {
      assignee_id: 1,
      review: { ...review, machine: review.machine.slice(1) }
    })
  ).toThrow('every AI-proposed field');
  expect(() =>
    action(structuredClone(current), 'confirm', {
      assignee_id: 1,
      review: { ...review, human: [{ field_key: review.machine[0].field_key, note: 'Duplicate.' }] }
    })
  ).toThrow('unique');
  expect(() =>
    action(structuredClone(current), 'confirm', {
      assignee_id: 1,
      review: { ...review, machine: review.machine.map((item) => ({ ...item, decision: 'REJECTED' })) }
    })
  ).toThrow('rejection reason');
  expect(
    mutations.confirm.safeParse({
      request_id: require('node:crypto').randomUUID(),
      expected_version: 0,
      assignee_id: 1,
      review: { ...review, human: [{ field_key: 'clearHeightFt', note: '   ' }] }
    }).success
  ).toBe(false);
  const saved = action(current, 'confirm', { assignee_id: 1, review });
  expect(saved.version).toBe(1);
  expect(saved.handoff.payload.fields).toHaveLength(review.machine.length);
});
test('both broker representations are excluded, while unavailability is not silently excluded', () => {
  expect(exclusion(row(1, { isBroker: ' YES ' }))).toBe('SKIPPED_BROKER');
  expect(exclusion(row(1, { warehouseOwnerType: ' broker ' }))).toBe('SKIPPED_BROKER');
  expect(exclusion(row(1, { isBroker: 'unknown' }))).toBeNull();
  expect(exclusion(row(1, { availabilityReview: { availability: 'No' } }))).toBeNull();
});
test('source projection omits personal contacts, addresses, media, embeddings and notes', () => {
  for (const field of [
    'contactPerson',
    'contactNumber',
    'address',
    'photos',
    'scoutNotes',
    'ownerCompanyName',
    'googleLocation'
  ])
    expect(select[field]).toBeUndefined();
  for (const field of ['latitude', 'longitude', 'geog', 'embedding'])
    expect(select.WarehouseData.select[field]).toBeUndefined();
  const current = snapshot(
    {
      id: 1,
      createdAt: new Date('2026-11-23T20:00:00Z'),
      warehouseType: 'PEB',
      handoverDate: new Date('2027-01-01'),
      availability: 'No'
    },
    {},
    'NEW_SUBMISSION',
    '2026-11-24T20:00:00Z'
  );
  expect(current.as_of_date).toBe('2026-11-25');
  expect(current.fields.handover.handoverDate).toBe('2027-01-01T00:00:00.000Z');
  expect(current.fields.availabilityReview.availability).toBe('No');
});
