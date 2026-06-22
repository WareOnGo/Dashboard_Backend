const { deriveZone } = require('../../src/utils/deriveZone');

describe('deriveZone', () => {
    const cases = [
        // NORTH
        ['Delhi', 'NORTH'], ['Punjab', 'NORTH'], ['Uttar Pradesh', 'NORTH'],
        ['Jammu and Kashmir', 'NORTH'], ['Ladakh', 'NORTH'], ['Chandigarh', 'NORTH'],
        // WEST
        ['Gujarat', 'WEST'], ['Maharashtra', 'WEST'], ['Goa', 'WEST'],
        ['Dadra and Nagar Haveli and Daman and Diu', 'WEST'],
        // SOUTH
        ['Karnataka', 'SOUTH'], ['Tamil Nadu', 'SOUTH'], ['Kerala', 'SOUTH'],
        ['Telangana', 'SOUTH'], ['Andhra Pradesh', 'SOUTH'], ['Puducherry', 'SOUTH'],
        ['Lakshadweep', 'SOUTH'], ['Andaman and Nicobar Islands', 'SOUTH'],
        // EAST (incl. North-East)
        ['Bihar', 'EAST'], ['West Bengal', 'EAST'], ['Assam', 'EAST'],
        ['Sikkim', 'EAST'], ['Manipur', 'EAST'], ['Tripura', 'EAST'],
        // CENTRAL
        ['Madhya Pradesh', 'CENTRAL'], ['Chhattisgarh', 'CENTRAL'], ['Odisha', 'CENTRAL'],
    ];

    it.each(cases)('maps %s -> %s', (state, zone) => {
        expect(deriveZone(state)).toBe(zone);
    });

    it('is case-insensitive and whitespace tolerant', () => {
        expect(deriveZone('  karnataka  ')).toBe('SOUTH');
        expect(deriveZone('TAMIL NADU')).toBe('SOUTH');
        expect(deriveZone('Maharashtra')).toBe('WEST');
    });

    it.each([
        ['Atlantis'], [''], ['   '], ['Unknown State'],
    ])('returns MISC for unmapped state %p', (state) => {
        expect(deriveZone(state)).toBe('MISC');
    });

    it.each([
        [null], [undefined], [123], [{}], [[]],
    ])('returns MISC for non-string input %p', (state) => {
        expect(deriveZone(state)).toBe('MISC');
    });
});
