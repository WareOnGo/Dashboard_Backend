jest.mock('../../src/utils/database', () => ({}));
const { buildFinalIdLabel } = require('../../src/services/gupshupService');

test.each(['APPROVED', 'REJECTED'])('%s notification labels use only current area options', outcome => {
    const row = { city: 'Bengaluru', totalSpaceSqft: [25000, 50000], offeredSpaceSqft: '99999' };
    const label = buildFinalIdLabel(outcome, row, 123);
    expect(label).toContain('25000/50000 sqft');
    expect(label).not.toContain('99999');
});

test.each([undefined, null, []])('notification labels do not revive legacy area when current area is %p', totalSpaceSqft => {
    expect(buildFinalIdLabel('APPROVED', { city: 'Bengaluru', totalSpaceSqft, offeredSpaceSqft: '99999' }, 123))
        .toBe('#123, Bengaluru');
});
