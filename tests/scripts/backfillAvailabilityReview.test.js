const { buildPlan } = require('../../scripts/backfillAvailabilityReview');
const now = new Date('2026-10-07T12:00:00Z');
const stage = overrides => ({ id: 's1', version: '10', availability: 'Yes', availabilityLastReviewedOn: null,
    initialAvailability: 'Yes', submittedAt: '2026-06-01T10:00:00Z', reviewStatus: 'APPROVED', warehouseId: 1, ...overrides });
const warehouse = overrides => ({ id: 1, version: '11', availability: 'Yes', availabilityLastReviewedOn: null,
    createdAt: '2026-06-05T10:00:00Z', ...overrides });
const audit = overrides => ({ id: 'a1', entity: 'warehouse', entityId: '1', action: 'UPDATE',
    createdAt: '2026-10-01T20:00:00Z', hasChanges: true,
    changes: [{ field: 'availability', from: 'No', to: 'Yes' }], ...overrides });
const plan = ({ warehouses = [], staged = [], audits = [] }) => buildPlan({ warehouses, staged, audits }, now);

test('uses the latest actual change, converted to the India calendar day', () => {
    const result = plan({ warehouses: [warehouse()], audits: [audit(), audit({ id: 'a0', createdAt: '2026-08-01T00:00:00Z' })] });
    expect(result.candidates[0]).toMatchObject({ date: '2026-10-02', evidence: { kind: 'audit_change', auditId: 'a1' } });
});

test('uses original availability creation for staging and its published warehouse, not approval time', () => {
    const result = plan({ warehouses: [warehouse()], staged: [stage()] });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map(row => row.date)).toEqual(['2026-06-01', '2026-06-01']);
    expect(result.candidates[1]).toMatchObject({ evidence: { kind: 'staged_submission_creation' }, sourceId: 's1', sourceVersion: '10' });
});

test('prefers a staged availability edit over its creation when promoting the evidence', () => {
    const result = plan({ warehouses: [warehouse({ createdAt: '2026-10-03T00:00:00Z' })], staged: [stage()],
        audits: [audit({ entity: 'staged_warehouse', entityId: 's1' })] });
    expect(result.candidates[1]).toMatchObject({ date: '2026-10-02', evidence: { kind: 'staged_audit_change', auditId: 'a1' } });
});

test('prefers the published warehouse change over older creation evidence', () => {
    const result = plan({ warehouses: [warehouse({ availability: 'No' })], staged: [stage()],
        audits: [audit({ changes: [{ field: 'availability', from: 'Yes', to: 'No' }] })] });
    expect(result.candidates[1]).toMatchObject({ date: '2026-10-02', evidence: { kind: 'audit_change' }, sourceId: null });
});

test('a generic edit with a real diff does not refresh availability', () => {
    const result = plan({ warehouses: [warehouse()], staged: [stage()], audits: [audit({ changes: [], availabilityMentioned: true })] });
    expect(result.candidates[1].date).toBe('2026-06-01');
});

test('an old field-list-only update blocks an older creation fallback', () => {
    const result = plan({ warehouses: [warehouse()], staged: [stage()],
        audits: [audit({ hasChanges: false, availabilityMentioned: true, changes: [] })] });
    expect(result.skipped).toContainEqual({ entity: 'warehouse', id: '1', reason: 'uncertain_legacy_update' });
});

test('a later proven change supersedes an ambiguous older edit', () => {
    const result = plan({ warehouses: [warehouse()], audits: [audit(), audit({ id: 'old', createdAt: '2026-08-01T00:00:00Z',
        hasChanges: false, availabilityMentioned: true, changes: [] })] });
    expect(result.candidates[0].date).toBe('2026-10-02');
});

test('does not fall back to an older matching value if the latest evidence contradicts the row', () => {
    const result = plan({ warehouses: [warehouse()], staged: [stage()],
        audits: [audit({ changes: [{ field: 'availability', from: 'Yes', to: 'No' }] })] });
    expect(result.skipped).toContainEqual({ entity: 'warehouse', id: '1', reason: 'current_value_mismatch' });
});

test.each([
    [{ availabilityLastReviewedOn: '2026-07-01' }, [], 'already_recorded'],
    [{ availability: null }, [], 'no_availability'],
    [{ availability: '  ' }, [], 'no_availability'],
    [{}, [audit({ reviewMentioned: true, changes: [] })], 'explicit_review_history'],
    [{}, [], 'no_creation_or_change_evidence'],
])('preserves recorded/cleared/unknown dates (%s)', (row, audits, reason) => {
    const result = plan({ warehouses: [warehouse(row)], audits });
    expect(result.candidates).toEqual([]);
    expect(result.skipped[0].reason).toBe(reason);
});

test.each([null, 'invalid', '2026-10-08T00:00:00Z'])('rejects invalid/future evidence timestamps: %s', createdAt => {
    const result = plan({ warehouses: [warehouse()], audits: [audit({ createdAt })] });
    expect(result.skipped[0].reason).toBe('invalid_or_future_history');
});

test('does not guess order for conflicting changes with equal timestamps', () => {
    const result = plan({ warehouses: [warehouse()], audits: [audit(), audit({ id: 'a2', changes: [{ field: 'availability', from: 'Yes', to: 'No' }] })] });
    expect(result.skipped[0].reason).toBe('ambiguous_history');
});

test('does not reinterpret the warehouse creation timestamp as evidence without an initial availability value', () => {
    const result = plan({ warehouses: [warehouse()], staged: [stage({ initialAvailability: null })],
        audits: [audit({ action: 'CREATE', changes: [] })] });
    expect(result.candidates).toEqual([]);
});

test('does not inherit from a pending submission or an ambiguous pair of origin rows', () => {
    for (const staged of [[stage({ reviewStatus: 'PENDING' })], [stage(), stage({ id: 's2' })]]) {
        const result = plan({ warehouses: [warehouse()], staged });
        expect(result.candidates.filter(row => row.entity === 'warehouse')).toEqual([]);
    }
});

test('does not use creation evidence newer than the published row', () => {
    const result = plan({ warehouses: [warehouse({ createdAt: '2026-05-01T00:00:00Z' })], staged: [stage()] });
    expect(result.candidates.filter(row => row.entity === 'warehouse')).toEqual([]);
});

test('preserves staged manual-review history, including a cleared date', () => {
    const result = plan({ staged: [stage()], audits: [audit({ entity: 'staged_warehouse', entityId: 's1', reviewMentioned: true, changes: [] })] });
    expect(result.skipped[0].reason).toBe('explicit_review_history');
});

test('does not turn case/whitespace-only normalization into a fresh review', () => {
    const result = plan({ warehouses: [warehouse()], staged: [stage()],
        audits: [audit({ changes: [{ field: 'availability', from: 'YES ', to: 'Yes' }] })] });
    expect(result.candidates[1].date).toBe('2026-06-01');
});

test('can use a CREATE audit that explicitly recorded initial availability', () => {
    const result = plan({ warehouses: [warehouse()], audits: [audit({ action: 'CREATE', initialAvailability: 'Yes', changes: [] })] });
    expect(result.candidates[0]).toMatchObject({ date: '2026-10-02', evidence: { kind: 'audit_creation' } });
});

test('a malformed availability diff is treated as uncertain evidence', () => {
    const result = plan({ warehouses: [warehouse()], audits: [audit({ changes: [{ field: 'availability', from: 'No' }] })] });
    expect(result.skipped[0].reason).toBe('uncertain_legacy_update');
});
