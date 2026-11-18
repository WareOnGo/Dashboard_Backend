const { pptFormIssues, flatFormValues } = require('../../src/utils/pptFormPolicy');
const { completePptForm, requiredPaths, patchForPath } = require('../fixtures/pptForm');

test('complete answers include zero counts, No, None and power as per requirement', () => {
    expect(pptFormIssues(null, completePptForm())).toEqual([]);
});
test.each(requiredPaths)('creation requires %s; filled edits cannot clear it', path => {
    for (const value of [undefined, null, '', ' ', 'N/A']) {
        const original = completePptForm(), patch = patchForPath(path, value);
        const edited = { ...original, ...patch, warehouseData: { ...original.warehouseData, ...patch.warehouseData } };
        expect(pptFormIssues(null, edited)).toEqual(expect.arrayContaining([expect.objectContaining({ path: path.split('.') })]));
        expect(pptFormIssues(original, patch)).toEqual(expect.arrayContaining([expect.objectContaining({ path: path.split('.') })]));
    }
});
test.each(requiredPaths)('older missing %s can stay missing, be filled, then becomes protected', path => {
    const complete = completePptForm(), blank = patchForPath(path, null);
    const old = { ...complete, ...blank, warehouseData: { ...complete.warehouseData, ...blank.warehouseData } };
    expect(pptFormIssues(old, { ...blank, scoutNotes: 'Unrelated edit' })).toEqual([]);
    expect(pptFormIssues(old, { scoutNotes: 'Unrelated edit' })).toEqual([]);
    const answer = flatFormValues(complete)[path.split('.').at(-1)];
    expect(pptFormIssues(old, patchForPath(path, answer))).toEqual([]);
    expect(pptFormIssues(complete, blank).length).toBeGreaterThan(0);
});
test.each([
    ['numberOfDocks', '-1'], ['numberOfDocks', '1.5'], ['clearHeightFt', '30 bananas'], ['floorStrengthPerSqm', '0'],
    ['plinthHeightFt', '-1 feet'], ['warehouseData.powerKva', false], ['warehouseData.fireNocAvailable', 'false'],
    ['ventilationType', 'None, Turbo'], ['washroom_count', 'Male: -1'], ['flooringType', 'Made up option'],
])('changed malformed %s is rejected while untouched legacy text remains saveable', (path, value) => {
    expect(pptFormIssues(completePptForm(), patchForPath(path, value)).length).toBeGreaterThan(0);
    const old = { ...completePptForm(), ...patchForPath(path, value) };
    expect(pptFormIssues(old, patchForPath(path, value))).toEqual([]);
});
test('handover validates the selected mode, merges partial updates and preserves inactive values', () => {
    const original = completePptForm();
    expect(pptFormIssues(original, { handoverDate: null })[0].path).toEqual(['handoverDate']);
    expect(pptFormIssues(original, { handoverType: 'VARIABLE' }).map(i => i.path[0])).toEqual(['handoverLeadValue', 'handoverLeadUnit']);
    const variable = { ...original, handoverType: 'VARIABLE', handoverLeadValue: 2, handoverLeadUnit: 'MONTHS' };
    expect(pptFormIssues(null, variable)).toEqual([]);
    expect(pptFormIssues(variable, { handoverLeadUnit: null })[0].path).toEqual(['handoverLeadUnit']);
    expect(pptFormIssues(variable, { handoverLeadValue: 3 })).toEqual([]);
    expect(pptFormIssues(variable, { handoverType: 'FIXED' })).toEqual([]);
    expect(pptFormIssues(variable, { handoverDate: null })[0].path).toEqual(['handoverDate']);
    expect(pptFormIssues({ handoverType: null, handoverDate: null }, { handoverType: 'FIXED', handoverDate: null })).toEqual([]);
    expect(pptFormIssues({ handoverType: 'VARIABLE', handoverLeadValue: 2 }, { handoverLeadValue: 2 })).toEqual([]);
    expect(pptFormIssues(original, { handoverDate: '2027-02-30' }).length).toBe(1);
});

test.each(['male', 'female'])('a saved %s washroom count cannot be omitted while retaining the other count', key => {
    const original = { ...completePptForm(), washroom_count: 'Male: 0; Female: 2' };
    const replacement = key === 'male' ? 'Female: 2' : 'Male: 0';
    expect(pptFormIssues(original, { washroom_count: replacement })).toEqual([
        expect.objectContaining({ path: ['washroom_count'], message: expect.stringContaining('cannot be cleared') }),
    ]);
    expect(pptFormIssues(original, { washroom_count: 'Male: 3; Female: 0' })).toEqual([]);
});
test('an unknown washroom component may stay unknown or be filled', () => {
    const original = { ...completePptForm(), washroom_count: 'Female: 2' };
    expect(pptFormIssues(original, { washroom_count: 'Female: 3' })).toEqual([]);
    expect(pptFormIssues(original, { washroom_count: 'Male: 0; Female: 3' })).toEqual([]);
});
test.each(['handoverLeadValue', 'handoverLeadUnit'])('inactive %s remains protected while Fixed timing is selected', key => {
    const original = { ...completePptForm(), handoverLeadValue: 2, handoverLeadUnit: 'WEEKS' };
    expect(pptFormIssues(original, { [key]: null })).toEqual([
        expect.objectContaining({ path: [key], message: expect.stringContaining('cannot be cleared') }),
    ]);
});
