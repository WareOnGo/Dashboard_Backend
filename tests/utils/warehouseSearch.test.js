const { phoneSearchDigits, warehouseSearchId } = require('../../src/utils/warehouseSearch');

test.each([
    '9876543210', '+919876543210', '919876543210', '+91 (98765) 43210',
    '0091 98765-43210', '09876543210', ' 98765.43210 ',
])('normalizes mobile search %s', term => {
    expect(phoneSearchDigits(term)).toBe('9876543210');
});

test.each([
    ['9123456789', '9123456789'], ['+91 91234 56789', '9123456789'],
    ['43210', '43210'], ['9876', '9876'], ['+1 (415) 555-0123', '14155550123'],
])('preserves local-number digits, fragments and other country codes: %s', (term, digits) => {
    expect(phoneSearchDigits(term)).toBe(digits);
});

test.each(['', ' ', '+91', '42', '123', '+()-', 'Sector 9876', '1234 OR 1=1', '9876%', '98_76', null])(
    'does not treat %s as a phone search', term => {
        expect(phoneSearchDigits(term)).toBeNull();
    },
);

test.each([
    ['42', 42], ['00042', 42], ['2147483647', 2147483647],
    ['2147483648', null], ['9876543210', null], ['919876543210', null],
    ['99999999999999999999999999999', null], ['0', null], ['+42', null], ['42.5', null],
])('only uses numeric search %s as an ID when it fits the database type', (term, expected) => {
    expect(warehouseSearchId(term)).toBe(expected);
});
