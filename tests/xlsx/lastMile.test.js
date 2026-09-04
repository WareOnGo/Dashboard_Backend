const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const sharp = require('sharp');
const { lastMileFields } = require('../../src/xlsx/lastMileFields');
const { createLastMileBuffer } = require('../../src/xlsx/lastMileService');
const { fetchImage } = require('../../src/ppt/utils/image');

jest.mock('../../src/ppt/utils/image', () => ({ fetchImage: jest.fn() }));

const warehouse = (id = 1) => ({
    id, address: `Property ${id}, Indore`, status: 'Ready to move',
    totalSpaceSqft: [25000], builtup_area: '99999', land_parcel_size: '2 acres', distance_from_highway: '4',
    handoverType: 'VARIABLE', handoverLeadValue: 2, handoverLeadUnit: 'MONTHS',
    waterSupply: 'BOREWELL', flooringType: 'VDF', floorStrengthPerSqm: '5 tonnes/sq m',
    numberOfDocks: '6', centreHeight: '30 ft', clearHeightFt: '26',
    ventilationType: 'Turbo vents', ratePerSqft: '15',
    photos: 'https://photos.test/one.webp,https://photos.test/two.png',
    ownerCompanyName: 'Owner is not necessarily developer', warehouseType: 'PEB',
    otherSpecifications: 'Internal notes should not be silently exported',
    WarehouseData: { latitude: 22.72, longitude: 75.86, powerKva: '15 KVA',
        fireSafetyMeasures: 'Sprinklers and hydrants', landType: 'Industrial' },
});
const values = (wh) => Object.fromEntries(lastMileFields(wh).map((row) => [row.label, row.value]));
const readWorkbook = async (buffer) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    return workbook;
};

beforeEach(() => jest.clearAllMocks());

describe('Last Mile database mapping', () => {
    it('maps every directly available field and preserves existing units', () => {
        expect(values(warehouse())).toMatchObject({
            '': '', 'Property Address': 'Property 1, Indore', Location: 'Property 1, Indore',
            'Distance From Highway': '4 km', 'Time frame for availability': '2 Months Post LOI',
            'Total Built up Area': '25,000 sq ft', 'Total Land Area': '2 acres',
            'Connected & Sanctioned  Electricity Load': '15 KVA',
            'Water Source & availability': 'Borewell', 'Land Zoning': 'Industrial',
            'Floor Type': 'VDF', 'Floor Loading (in tonnes/meters square)': '5 tonnes/sq m',
            'Fire Fighting System/ Sprinklers': 'Sprinklers and hydrants',
            'Number of Docks/exits': '6', 'Shed Height (Centre)': '30 ft',
            'Shed Height (Eve/Side)': '26 ft', Ventilation: 'Turbo vents',
            'Quoted Rent in Rs./sq. ft./month': '15',
        });
        expect(lastMileFields(warehouse())[0].value).toBe('Ready to move');
    });

    it('does not use offered area for land area or invent missing facilities', () => {
        const fields = values({ offeredSpaceSqft: '9999', totalSpaceSqft: [9999], waterSupply: 'NONE' });
        for (const label of ['Total Land Area', 'Developer Name', 'Plan Sanction', 'Office area',
            'Adjacent Occupiers', 'Roof Type', 'Comments', 'Fire Fighting System/ Sprinklers',
            'Connected & Sanctioned  Electricity Load', 'Time frame for availability']) {
            expect(fields[label]).toBe('NA');
        }
        expect(fields['Water Source & availability']).toBe('None');
    });

    it('preserves separate offered-area options instead of summing them', () => {
        expect(values({ totalSpaceSqft: [25000, 50000] })['Total Built up Area']).toBe('25,000 / 50,000 sq ft');
    });

    it.each([undefined, null, []])('keeps the area NA when totalSpaceSqft is missing (%p)', (totalSpaceSqft) => {
        expect(values({ totalSpaceSqft, builtup_area: '99999', offeredSpaceSqft: '12345' })['Total Built up Area']).toBe('NA');
    });

    it('handles null relations, placeholders and zero without claiming immediate availability', () => {
        const fields = values({ WarehouseData: null, builtup_area: ' N/A ', ratePerSqft: '0', numberOfDocks: 0 });
        expect(fields['Total Built up Area']).toBe('NA');
        expect(fields['Quoted Rent in Rs./sq. ft./month']).toBe('0');
        expect(fields['Number of Docks/exits']).toBe('0');
        expect(fields['Time frame for availability']).toBe('NA');
        expect(fields['Google Coordinated']).toBe('NA');
    });

    it('uses only successful, finite stored road distances for the matching landmark category', () => {
        expect(values({ WarehouseProximity: [
            { category: 'railway_station', status: 'OK', roadKm: 0 },
            { category: 'aerodrome', status: 'OK', roadKm: 29.4 },
            { category: 'national_highway', status: 'OK', roadKm: 4 },
        ] })).toMatchObject({ 'Distance from Railway': '0 km', 'Distance from Airport': '29.4 km', 'Distance From Highway': '4 km' });
        for (const row of [
            { category: 'aerodrome', status: 'NO_ROUTE', roadKm: 4 },
            { category: 'aerodrome', status: 'OK', roadKm: null },
            { category: 'aerodrome', status: 'OK', roadKm: -1 },
            { category: 'aerodrome', status: 'OK', roadKm: Infinity },
        ]) expect(values({ WarehouseProximity: [row] })['Distance from Airport']).toBe('NA');
    });

    it('keeps developer name and comments NA even when database candidates are populated', () => {
        expect(values(warehouse())).toMatchObject({ 'Developer Name': 'NA', Comments: 'NA' });
    });

    it('prefers the stored highway road distance over the legacy warehouse field', () => {
        expect(values({ ...warehouse(), WarehouseProximity: [
            { category: 'national_highway', status: 'OK', roadKm: 1.75 },
        ] })['Distance From Highway']).toBe('1.75 km');
    });

    it.each([null, '', 'NA', ' N/A '])('uses the computed highway distance when the legacy value is %p', (legacy) => {
        expect(values({ distance_from_highway: legacy, WarehouseProximity: [
            { category: 'national_highway', status: 'OK', roadKm: 2.5 },
        ] })['Distance From Highway']).toBe('2.5 km');
    });

    it('shows Direct access for a successfully measured property on the highway', () => {
        expect(values({ ...warehouse(), WarehouseProximity: [
            { category: 'national_highway', status: 'OK', roadKm: 0.01, warnings: ['ON_HIGHWAY'] },
        ] })['Distance From Highway']).toBe('Direct access');
    });

    it.each([
        { status: 'IDENTITY_ONLY', roadKm: null },
        { status: 'NONE_IN_RANGE', roadKm: null },
        { status: 'ROUTING_FAILED', roadKm: 3, warnings: ['ON_HIGHWAY'] },
        { status: 'OK', roadKm: null },
        { status: 'OK', roadKm: -1 },
        { status: 'OK', roadKm: NaN },
        { status: 'OK', roadKm: Infinity },
    ])('falls back to the warehouse field for unusable highway proximity (%p)', (proximity) => {
        const wh = { WarehouseProximity: [{ category: 'national_highway', ...proximity }] };
        expect(values({ ...wh, distance_from_highway: '800 m' })['Distance From Highway']).toBe('800 m');
        expect(values(wh)['Distance From Highway']).toBe('NA');
    });

    it('preserves a recorded zero highway distance', () => {
        expect(values({ WarehouseProximity: [
            { category: 'national_highway', status: 'OK', roadKm: 0 },
        ] })['Distance From Highway']).toBe('0 km');
    });

    it('uses stored map links, falls back to valid coordinates including zero, and avoids unsafe hyperlinks', () => {
        expect(values({ googleLocation: 'https://maps.app.goo.gl/site' })['Google Coordinated'])
            .toEqual({ text: 'https://maps.app.goo.gl/site', hyperlink: 'https://maps.app.goo.gl/site' });
        expect(values({ WarehouseData: { latitude: 0, longitude: 0 } })['Google Coordinated'].hyperlink)
            .toContain('query=0,0');
        expect(values({ WarehouseData: { latitude: 91, longitude: 0 } })['Google Coordinated']).toBe('NA');
        expect(values({ googleLocation: 'javascript:alert(1)' })['Google Coordinated']).toBe('javascript:alert(1)');
    });
});

describe('Last Mile XLSX output', () => {
    it('exports the checked area values for 1908 and 1980 without changing the input records', async () => {
        // Area fields from the earlier read-only lookup; tests do not connect to DB.
        const records = [
            { id: 1908, builtup_area: null, land_parcel_size: null, totalSpaceSqft: [78000] },
            { id: 1980, builtup_area: null, land_parcel_size: null, totalSpaceSqft: [2000] },
        ];
        const original = JSON.parse(JSON.stringify(records));
        const workbook = await readWorkbook(await createLastMileBuffer(records));
        const sheet = workbook.worksheets[0];
        expect(sheet.getCell('B14').text).toBe('78,000 sq ft');
        expect(sheet.getCell('C14').text).toBe('2,000 sq ft');
        expect(sheet.getCell('B15').text).toBe('NA');
        expect(sheet.getCell('C15').text).toBe('NA');
        expect(records).toEqual(original);
    });

    it('writes highway values and consultant placeholders into their actual workbook cells', async () => {
        const workbook = await readWorkbook(await createLastMileBuffer([
            { ...warehouse(1), distance_from_highway: null, WarehouseProximity: [
                { category: 'national_highway', status: 'OK', roadKm: 1.75 },
            ] },
            { ...warehouse(2), WarehouseProximity: [
                { category: 'national_highway', status: 'OK', roadKm: 0.01, warnings: ['ON_HIGHWAY'] },
            ] },
            warehouse(3),
            { id: 4 },
        ]));
        const sheet = workbook.worksheets[0];
        expect(['B9', 'C9', 'D9', 'E9'].map((cell) => sheet.getCell(cell).text))
            .toEqual(['1.75 km', 'Direct access', '4 km', 'NA']);
        for (const column of ['B', 'C', 'D', 'E']) {
            expect(sheet.getCell(`${column}5`).text).toBe('NA');
            expect(sheet.getCell(`${column}31`).text).toBe('NA');
        }
    });

    it('round-trips the 32-row template with styles, hyperlinks, numeric-looking rent and no sample data', async () => {
        const workbook = await readWorkbook(await createLastMileBuffer([warehouse(8), warehouse(2)]));
        const sheet = workbook.worksheets[0];
        expect(sheet.rowCount).toBe(32);
        expect(sheet.columnCount).toBe(3);
        expect(sheet.getCell('A2').value).toBe('Property Details');
        expect(sheet.getCell('A12').value).toBe('Building Details');
        expect(sheet.getCell('A29').value).toBe('Commercial Details');
        expect(sheet.getCell('B2').value).toBe('Option 1');
        expect(sheet.getCell('B3').value).toBe('Property 8, Indore');
        expect(sheet.getCell('C3').value).toBe('Property 2, Indore');
        expect(sheet.getCell('B4').value).toBe('Images NA');
        expect(sheet.getCell('B30').value).toBe('15');
        expect(sheet.getCell('B30').numFmt).not.toBe('0%');
        expect(sheet.getCell('B2').fill.fgColor.argb).toBe('FF005137');
        expect(sheet.getCell('A2').fill.fgColor.argb).toBe('FF66CC33');
        expect(sheet.getCell('A3').fill.fgColor.argb).toBe('FFD9D9D9');
        expect(sheet.getCell('B3').alignment.wrapText).toBe(true);
        expect(sheet.getCell('B32').value.hyperlink).toContain('query=22.72,75.86');
        expect(sheet.views[0]).toMatchObject({ state: 'frozen', xSplit: 1, ySplit: 2 });
        expect(sheet.pageSetup.printArea).toBe('A1:C32');
        expect(sheet.pageSetup.orientation).toBe('portrait');
        expect(fetchImage).not.toHaveBeenCalled();
    });

    it('carries every selected property across sheets in order, with global option numbering', async () => {
        const workbook = await readWorkbook(await createLastMileBuffer(Array.from({ length: 9 }, (_, i) => warehouse(i + 1))));
        expect(workbook.worksheets).toHaveLength(3);
        expect(workbook.worksheets[0].getCell('E2').value).toBe('Option 4');
        expect(workbook.worksheets[1].getCell('B2').value).toBe('Option 5');
        expect(workbook.worksheets[2].getCell('B2').value).toBe('Option 9');
        expect(workbook.worksheets[2].columnCount).toBe(2);
    });

    it('embeds one selected listing photo as a real, bounded PNG image', async () => {
        const source = await sharp({ create: { width: 600, height: 300, channels: 3, background: 'green' } }).webp().toBuffer();
        fetchImage.mockResolvedValue({ data: `data:image/webp;base64,${source.toString('base64')}` });
        const buffer = await createLastMileBuffer([warehouse()], { 1: ['https://photos.test/one.webp'] });
        const workbook = await readWorkbook(buffer);
        const sheet = workbook.worksheets[0];
        expect(fetchImage).toHaveBeenCalledTimes(1);
        expect(fetchImage).toHaveBeenCalledWith('https://photos.test/one.webp', expect.objectContaining({ timeout: 8000 }));
        expect(sheet.getImages()).toHaveLength(1);
        expect(sheet.getImages()[0].range.ext).toEqual({ width: 240, height: 120 });
        expect(sheet.getCell('B4').text).toBe('');
        const zip = await JSZip.loadAsync(buffer);
        expect(Object.keys(zip.files).filter((name) => /xl\/media\/.*\.png$/.test(name))).toHaveLength(1);
    });

    it.each([2, 3, 4])('fits %i selected photos inside the same cell without overlap or distortion', async (count) => {
        const urls = Array.from({ length: count }, (_, i) => `https://photos.test/${i}.png`);
        const colors = ['red', 'blue', 'lime', 'yellow'];
        const sources = await Promise.all(urls.map((_, i) => sharp({ create: {
            width: i % 2 ? 300 : 600, height: i % 2 ? 600 : 300,
            channels: 3, background: colors[i],
        } }).png().toBuffer()));
        fetchImage.mockImplementation(async (url) => ({ data: `data:image/png;base64,${sources[urls.indexOf(url)].toString('base64')}` }));
        const workbook = await readWorkbook(await createLastMileBuffer([
            { ...warehouse(), photos: urls.join(',') },
        ], { 1: urls }));
        const sheet = workbook.worksheets[0];
        const images = sheet.getImages();
        expect(images).toHaveLength(count);
        expect(sheet.getCell('B4').text).toBe('');
        expect(sheet.getRow(4).height).toBe(150);
        const boxes = [];
        for (let i = 0; i < images.length; i++) {
            const { tl, ext, editAs } = images[i].range;
            expect(tl.nativeCol).toBe(1);
            expect(tl.nativeRow).toBe(3);
            expect(editAs).toBe('oneCell');
            const x = tl.nativeColOff / 9525;
            const y = tl.nativeRowOff / 9525;
            expect(x).toBeGreaterThanOrEqual(5);
            expect(y).toBeGreaterThanOrEqual(8);
            expect(x + ext.width).toBeLessThanOrEqual(245.001);
            expect(y + ext.height).toBeLessThanOrEqual(192.001);
            expect(ext.width / ext.height).toBeCloseTo(i % 2 ? 0.5 : 2);
            boxes.push({ x, y, width: ext.width, height: ext.height });
            // Loaded workbook image order must still match the selected photos.
            const stats = await sharp(workbook.getImage(images[i].imageId).buffer).stats();
            const expected = [[255, 0, 0], [0, 0, 255], [0, 255, 0], [255, 255, 0]][i];
            expect(stats.channels.slice(0, 3).map((channel) => Math.round(channel.mean))).toEqual(expected);
        }
        for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
                const a = boxes[i], b = boxes[j];
                expect(a.x + a.width <= b.x || b.x + b.width <= a.x
                    || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
            }
        }
    });

    it('caps API selections at four distinct listing photos', async () => {
        const urls = Array.from({ length: 5 }, (_, i) => `https://photos.test/${i}.png`);
        const source = await sharp({ create: { width: 40, height: 40, channels: 3, background: 'green' } }).png().toBuffer();
        fetchImage.mockResolvedValue({ data: `data:image/png;base64,${source.toString('base64')}` });
        const workbook = await readWorkbook(await createLastMileBuffer([
            { ...warehouse(), photos: urls.join(',') },
        ], { 1: [urls[0], ...urls] }));
        expect(fetchImage.mock.calls.map(([url]) => url)).toEqual(urls.slice(0, 4));
        expect(workbook.worksheets[0].getImages()).toHaveLength(4);
    });

    it('keeps the other photos when one fails and expands the remaining photo to fit the cell', async () => {
        const source = await sharp({ create: { width: 600, height: 300, channels: 3, background: 'green' } }).png().toBuffer();
        fetchImage.mockRejectedValueOnce(new Error('Timeout'))
            .mockResolvedValueOnce({ data: `data:image/png;base64,${source.toString('base64')}` });
        const workbook = await readWorkbook(await createLastMileBuffer([warehouse()], {
            1: ['https://photos.test/one.webp', 'https://photos.test/two.png'],
        }));
        expect(workbook.worksheets[0].getImages()).toHaveLength(1);
        expect(workbook.worksheets[0].getImages()[0].range.ext).toEqual({ width: 240, height: 120 });
        expect(workbook.worksheets[0].getCell('B4').text).toBe('');
    });

    it.each([undefined, [], ['https://unselected.test/private.png']])('does not fetch unselected or non-listing photos (%p)', async (selection) => {
        const workbook = await readWorkbook(await createLastMileBuffer([warehouse()], { 1: selection }));
        expect(workbook.worksheets[0].getCell('B4').value).toBe('Images NA');
        expect(fetchImage).not.toHaveBeenCalled();
    });

    it.each(['network', 'corrupt'])('keeps the workbook downloadable after a %s photo failure', async (kind) => {
        if (kind === 'network') fetchImage.mockRejectedValue(new Error('Timeout'));
        else fetchImage.mockResolvedValue({ data: 'data:image/jpeg;base64,aW52YWxpZA==' });
        const workbook = await readWorkbook(await createLastMileBuffer([warehouse()], { 1: ['https://photos.test/one.webp'] }));
        expect(workbook.worksheets[0].getCell('B4').value).toBe('Images NA');
        expect(workbook.worksheets[0].getImages()).toHaveLength(0);
    });

    it('writes formula-like database values as text and wraps long addresses', async () => {
        const buffer = await createLastMileBuffer([{ ...warehouse(), address: '=HYPERLINK("bad")', ratePerSqft: '+123' },
            { ...warehouse(2), address: 'Long address '.repeat(40) }]);
        const workbook = await readWorkbook(buffer);
        const sheet = workbook.worksheets[0];
        expect(sheet.getCell('B3').value).toBe('=HYPERLINK("bad")');
        expect(sheet.getCell('B3').formula).toBeUndefined();
        expect(sheet.getCell('B30').value).toBe('+123');
        expect(sheet.getRow(3).height).toBeGreaterThan(56);
    });

    it('rejects an empty selection', async () => {
        await expect(createLastMileBuffer([])).rejects.toThrow('At least one warehouse');
    });
});
