const { propertyFields } = require('../../src/ppt/slides/propertyFields');
const fields = row => Object.fromEntries(propertyFields(row).map(field => [field.label, field.value]));
test('explicit metric, power and CLU units survive PPT formatting', () => {
    expect(fields({ clearHeightFt: '10 metres', WarehouseData: { powerKva: '100 HP', landType: 'Warehouse CLU' } }))
        .toMatchObject({ 'Eaves Height': '10 metres', 'Electrical workload': '100 HP', 'Status of Land': 'Warehouse CLU' });
});
test('old bare numbers retain their historical unit in PPTs', () => {
    expect(fields({ clearHeightFt: '30', WarehouseData: { powerKva: '100', landType: 'Industrial' } }))
        .toMatchObject({ 'Eaves Height': '30 ft', 'Electrical workload': '100 KVA', 'Status of Land': 'Industrial CLU' });
});
test('ranges, descriptive heights and existing kVA units are not rewritten', () => {
    expect(fields({ clearHeightFt: '8–12 metres', WarehouseData: { powerKva: '100 kVA' } }))
        .toMatchObject({ 'Eaves Height': '8–12 metres', 'Electrical workload': '100 kVA' });
});
