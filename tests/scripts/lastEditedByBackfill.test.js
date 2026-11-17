const { buildPlan } = require('../../scripts/backfillWarehouseLastEditedBy');
const now = new Date('2026-11-17T16:00:00Z');
const warehouse = { id: 1, version: '10', lastEditedBy: null };
const audit = (overrides = {}) => ({
    id: 'edit', version: '11', entity: 'warehouse', entityId: '1', action: 'UPDATE',
    userEmail: 'editor@example.test', createdAt: '2026-10-02T12:00:00Z',
    hasChanges: true, changedFields: ['city'], ...overrides,
});
const plan = audits => buildPlan({ warehouses: [warehouse], staged: [], audits }, now);

test('latest actual editor wins over reads, no-op saves, and system backfills', () => {
    const result = plan([
        audit({ id: 'old', createdAt: '2026-10-01T12:00:00Z', userEmail: 'old@example.test' }),
        audit(),
        audit({ id: 'read', action: 'READ', createdAt: '2026-10-03T12:00:00Z', userEmail: 'reader@example.test' }),
        audit({ id: 'noop', changedFields: [], changeCount: 0, createdAt: '2026-10-04T12:00:00Z', userEmail: 'other@example.test' }),
        audit({ id: 'system', createdAt: '2026-10-05T12:00:00Z', userEmail: 'system:availability-review-backfill' }),
        audit({ id: 'metadata', createdAt: '2026-10-06T12:00:00Z', changedFields: ['lastEditedBy'] }),
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ value: 'editor@example.test', evidence: { auditId: 'edit' } });
});

test('older logs without diffs still supply recorded edit identity', () => {
    expect(plan([audit({ hasChanges: false, updatedFields: ['city'] })]).candidates[0].evidence.kind).toBe('legacy_edit');
});

test.each([null, '', 'Scout Name'])('Scout creation falls back to recorded user ID when email is %s', userEmail => {
    const result = plan([audit({ action: 'CREATE', userEmail, source: 'SCOUT_FORM', scoutId: 42 })]);
    expect(result.candidates[0]).toMatchObject({ value: '42', evidence: { identitySource: 'scoutId' } });
});

test('does not guess an editor from uploadedBy or fall back past an unidentified latest edit', () => {
    expect(plan([]).skipped[0].reason).toBe('no_audit_evidence');
    const result = plan([audit(), audit({ id: 'unknown', userEmail: 'anonymous', createdAt: '2026-10-03T12:00:00Z' })]);
    expect(result.candidates).toEqual([]);
    expect(result.skipped[0].reason).toBe('latest_actor_unavailable');
});

test('ambiguous simultaneous editors and future events are left unfilled', () => {
    expect(plan([audit(), audit({ id: 'tie', userEmail: 'other@example.test' })]).skipped[0].reason).toBe('ambiguous_latest_actor');
    expect(plan([audit({ createdAt: '2026-12-01' })]).skipped[0].reason).toBe('invalid_or_future_history');
});

test('publication inherits the content editor, including when its CREATE log arrives after auto-approval', () => {
    const creation = audit({ id: 'creation', entity: 'staged_warehouse', entityId: 'origin', action: 'CREATE', createdAt: '2026-10-01T12:00:01Z' });
    const approval = audit({ id: 'approval', entity: 'staged_warehouse', entityId: 'origin', action: 'APPROVE', warehouseId: 1,
        userEmail: 'system:auto-approve', createdAt: '2026-10-01T12:00:00Z' });
    const result = plan([creation, approval]);
    expect(result.candidates[0]).toMatchObject({ value: 'editor@example.test', sourceId: 'origin', evidence: { auditId: 'creation', approvalAuditId: 'approval' } });
    // A later edit to staging after publication must not change the live record's attribution.
    const laterEdit = audit({ id: 'later', entity: 'staged_warehouse', entityId: 'origin', userEmail: 'later@example.test' });
    expect(plan([creation, approval, laterEdit]).candidates[0].value).toBe('editor@example.test');
    expect(plan([creation, approval, audit({ userEmail: 'live-editor@example.test' })]).candidates[0].value).toBe('live-editor@example.test');
});

test('pre-existing attribution is retained', () => {
    const result = buildPlan({ warehouses: [{ ...warehouse, lastEditedBy: 'existing@example.test' }], staged: [], audits: [audit()] }, now);
    expect(result.candidates).toEqual([]);
    expect(result.skipped[0].reason).toBe('already_recorded');
});

test('email-less dashboard audits retain their server-recorded user ID', () => {
    expect(plan([audit({ userEmail: 'user-7', actorUserId: 'user-7' })]).candidates[0])
        .toMatchObject({ value: 'user-7', evidence: { identitySource: 'actorUserId' } });
});
