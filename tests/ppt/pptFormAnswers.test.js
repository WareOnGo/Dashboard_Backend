const { generateDetailedSlideV3 } = require('../../src/ppt/slides/v3/detailedSlideV3');
const { completePptForm } = require('../fixtures/pptForm');
const { formatHandover } = require('../../src/ppt/utils/handover');
const { propertyFields } = require('../../src/ppt/slides/propertyFields');
const capture = async overrides => {
    const slide = { addText: jest.fn(), addImage: jest.fn(), addShape: jest.fn(), addTable: jest.fn() };
    const form = completePptForm();
    const warehouse = { ...form, id: 123, WarehouseData: form.warehouseData, ...overrides };
    await generateDetailedSlideV3({ addSlide: () => slide, handoverReferenceDate: new Date('2026-11-19') }, warehouse, [], 1);
    return Object.fromEntries(slide.addTable.mock.calls[0][0].filter(row => row.length === 2).map(row => [row[0].text, row[1].text]));
};
test('V3 displays captured answers including zero, No and None rather than default toilets', async () => {
    expect(await capture()).toMatchObject({
        'No. of docks': '0 Nos', 'Plinth Height': '0 feet', 'Toilets': 'Male: 0; Female: 0',
        'Canopy details': 'None', 'Ventilation details': 'None', 'Electrical workload': 'As per requirement',
        'Fire safety details': 'None, NOC Not available', 'Handover timeline': '28 Feb 2027',
    });
});
test.each([null, '', 'N/A'])('missing legacy washrooms %p are unconfirmed in V3', async washroom_count => {
    expect((await capture({ washroom_count })).Toilets).toBe('Unconfirmed');
});
test('V3 still excludes insulation and stability certification; TCI remains unchanged', async () => {
    const fields = await capture();
    expect(fields).not.toHaveProperty('Insulation details');
    expect(fields).not.toHaveProperty('Building Stability Certificate');
    expect(propertyFields({}).find(row => row.label === 'Toilets').value).toBe('Available');
    expect(formatHandover({ handoverType: 'VARIABLE', handoverLeadValue: 2, handoverLeadUnit: 'WEEKS' })).toBe('2 Weeks Post LOI');
});
