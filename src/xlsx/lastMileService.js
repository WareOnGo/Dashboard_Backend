const ExcelJS = require('exceljs');
const sharp = require('sharp');
const { lastMileFields } = require('./lastMileFields');
const { fetchImage } = require('../ppt/utils/image');

const OPTIONS_PER_SHEET = 4;
const BORDER = Object.fromEntries(['top', 'left', 'bottom', 'right']
    .map((edge) => [edge, { style: 'thin', color: { argb: 'FF000000' } }]));
const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

async function addPhotos(workbook, sheet, warehouse, selection, column) {
    const cell = sheet.getCell(4, column);
    cell.value = 'Images NA';
    // As with client decks, only explicitly selected photos are exported. Require
    // them to belong to the loaded listing before making any remote request.
    const allowed = new Set((warehouse.photos || '').split(',').map((url) => url.trim()));
    const urls = [...new Set(Array.isArray(selection) ? selection : [])].slice(0, 4)
        .filter((url) => typeof url === 'string' && allowed.has(url) && /^https?:\/\//i.test(url));
    const photos = (await Promise.all(urls.map(async (url) => {
        try {
            const { data } = await fetchImage(url, {
                timeout: 8000, maxContentLength: 8 * 1024 * 1024, maxRedirects: 0,
            });
            // Excel supports PNG/JPEG/GIF; normalize WebP/SVG. Keep enough pixels
            // for a sharp single photo while bounding memory and workbook size.
            return await sharp(Buffer.from(data.split(',')[1], 'base64'))
                .rotate().resize({ width: 480, height: 368, fit: 'inside', withoutEnlargement: true })
                .png().toBuffer({ resolveWithObject: true });
        } catch (_) {
            // Keep the other selected images if one cannot be downloaded/decoded.
            return null;
        }
    }))).filter(Boolean);
    if (!photos.length) return;

    // Fit all photos inside the existing 35-character-wide, 150-point-high cell.
    // One photo uses the full box, two sit side by side, three/four form a 2x2 grid.
    const columns = photos.length === 1 ? 1 : 2;
    const rows = Math.ceil(photos.length / columns);
    const gap = 6;
    const slotWidth = (240 - gap * (columns - 1)) / columns;
    const slotHeight = (184 - gap * (rows - 1)) / rows;
    photos.forEach(({ data: buffer, info }, index) => {
        const scale = Math.min(slotWidth / info.width, slotHeight / info.height, 1);
        const width = info.width * scale;
        const height = info.height * scale;
        const x = 5 + (index % columns) * (slotWidth + gap) + (slotWidth - width) / 2;
        const y = 8 + Math.floor(index / columns) * (slotHeight + gap) + (slotHeight - height) / 2;
        const imageId = workbook.addImage({ buffer, extension: 'png' });
        sheet.addImage(imageId, {
            // Explicit EMU offsets avoid ExcelJS's fractional custom-column-width
            // conversion, which would put the second image over the first.
            tl: { nativeCol: column - 1, nativeRow: 3,
                nativeColOff: Math.round(x * 9525), nativeRowOff: Math.round(y * 9525) },
            ext: { width, height },
            editAs: 'oneCell',
        });
    });
    cell.value = '';
}

/** Generate the Last Mile comparison, with up to four options per worksheet. */
async function createLastMileBuffer(warehouses, selectedImages = {}, customDetails = {}) {
    if (!Array.isArray(warehouses) || warehouses.length === 0) {
        throw new Error('At least one warehouse is required for Last Mile Excel generation.');
    }
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'WareOnGo';
    workbook.title = `Last Mile - ${customDetails.clientRequirement?.trim() || 'Warehouse Options'}`;
    workbook.subject = customDetails.clientName?.trim() || 'Last Mile';

    for (let start = 0; start < warehouses.length; start += OPTIONS_PER_SHEET) {
        const batch = warehouses.slice(start, start + OPTIONS_PER_SHEET);
        const sheet = workbook.addWorksheet(start === 0 ? 'WH Options' : `WH Options ${start + 1}-${start + batch.length}`, {
            views: [{ state: 'frozen', xSplit: 1, ySplit: 2, topLeftCell: 'B3' }],
            pageSetup: { orientation: 'portrait', paperSize: 8, fitToPage: true, fitToWidth: 1, fitToHeight: 1 },
        });
        sheet.getColumn(1).width = 29;
        batch.forEach((_, i) => { sheet.getColumn(i + 2).width = 35; });
        const fields = batch.map(lastMileFields);
        fields[0].forEach((field, rowIndex) => {
            const row = sheet.getRow(rowIndex + 1);
            row.getCell(1).value = field.label;
            batch.forEach((_, colIndex) => {
                row.getCell(colIndex + 2).value = field.kind === 'section'
                    ? (rowIndex === 1 ? `Option ${start + colIndex + 1}` : '')
                    : fields[colIndex][rowIndex].value ?? '';
            });
            let lines = 1;
            for (let col = 1; col <= batch.length + 1; col++) {
                const cell = row.getCell(col);
                cell.font = { name: 'Calibri', size: 10, bold: col === 1 || ['section', 'status'].includes(field.kind) };
                cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
                cell.border = BORDER;
                if (field.kind === 'section' || (field.kind === 'status' && col === 1)) {
                    cell.fill = fill(col === 1 ? 'FF66CC33' : 'FF005137');
                    cell.font = { ...cell.font, color: { argb: 'FFFFFFFF' } };
                } else if (field.kind === 'status') {
                    cell.fill = fill('FF92D050');
                } else if (col === 1) {
                    cell.fill = fill('FFD9D9D9');
                }
                if (cell.value?.hyperlink) cell.font = { ...cell.font, color: { argb: 'FF0563C1' }, underline: true };
                // Estimate wrapping to prevent long DB text clipping in fixed sample heights.
                lines = Math.max(lines, ...cell.text.split('\n').map((line) => Math.ceil(line.length / (col === 1 ? 26 : 32))));
            }
            row.height = Math.min(409, Math.max(field.height || 20, lines * 13 + 6));
        });
        sheet.pageSetup.printArea = `A1:${sheet.getColumn(batch.length + 1).letter}32`;
        await Promise.all(batch.map((warehouse, i) => addPhotos(
            workbook, sheet, warehouse, selectedImages?.[warehouse.id], i + 2,
        )));
    }
    return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = { createLastMileBuffer };
