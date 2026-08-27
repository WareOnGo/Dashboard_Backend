const PptxGenJS = require('pptxgenjs');

const { generateTitleSlideTci } = require('../slides/tci/titleSlideTci');
const { generateDetailedSlideTci } = require('../slides/tci/detailedSlideTci');
const { generateThankYouSlideTci } = require('../slides/tci/thankYouSlideTci');

// Placeholder warehouses used when the caller doesn't supply real data yet —
// lets the layout be visually validated before the data API is wired up.
const PLACEHOLDER_WAREHOUSES = [
    {
        id: 'P1', projectName: 'Begur Taluk Nelamangala', city: 'Nelamangala', state: 'Karnataka',
        warehouseType: 'Ready To Move – PEB Structure',
        totalSpaceSqft: [75000], ratePerSqft: 23,
        clearHeightFt: 36, centreHeight: 40,
        flooringType: 'VDF Flooring', floorStrengthPerSqm: '5 T/sqm',
        numberOfDocks: 'As per requirement', availability: 'Immediate',
        googleLocation: 'https://maps.google.com/?q=13.10,77.34',
        WarehouseData: { latitude: 13.10, longitude: 77.34, landType: 'Industrial', fireNocAvailable: true,
            fireSafetyMeasures: 'Hydrants + Fire Advisory. Sprinklers can be installed at additional cost.' },
        photos: '',
    },
    {
        id: 'P2', projectName: 'Kalisipalya Begur', city: 'Bengaluru', state: 'Karnataka',
        warehouseType: 'Ready To Move – PEB Structure',
        totalSpaceSqft: [79000], ratePerSqft: 24,
        clearHeightFt: 32, centreHeight: 36,
        flooringType: 'VDF', floorStrengthPerSqm: '5 T/sqm',
        numberOfDocks: '5', availability: 'Immediate',
        googleLocation: 'https://maps.google.com/?q=13.05,77.55',
        WarehouseData: { latitude: 13.05, longitude: 77.55, landType: 'Industrial', fireNocAvailable: true,
            fireSafetyMeasures: 'Hydrants + Fire Advisory + Sprinklers' },
        photos: '',
    },
    {
        id: 'P3', projectName: 'Begur Lower Warehouse', city: 'Bengaluru', state: 'Karnataka',
        warehouseType: 'Under Construction – PEB Structure',
        totalSpaceSqft: [115000], ratePerSqft: 22,
        clearHeightFt: 32, centreHeight: 36,
        flooringType: 'VDF', floorStrengthPerSqm: '5 T/sqm',
        numberOfDocks: 'As per requirement', availability: 'March 2026',
        googleLocation: 'https://maps.google.com/?q=13.04,77.50',
        WarehouseData: { latitude: 13.04, longitude: 77.50, landType: 'Industrial', fireNocAvailable: false,
            fireSafetyMeasures: 'Hydrants will be installed' },
        photos: '',
    },
];

const createPptBufferTci = async (warehouses, selectedImages = {}, customDetails = {}) => {
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_4x3'; // 10" x 7.5" — matches the source TCI template aspect

    const list = (warehouses && warehouses.length) ? warehouses : PLACEHOLDER_WAREHOUSES;

    await generateTitleSlideTci(pptx, list, customDetails);

    for (let i = 0; i < list.length; i++) {
        const w = list[i];
        const photos = selectedImages[w.id] || (typeof w.photos === 'string' && w.photos.trim()
            ? w.photos.split(',').map((s) => s.trim()).filter(Boolean)
            : []);
        await generateDetailedSlideTci(pptx, w, photos, i + 1);
    }

    generateThankYouSlideTci(pptx);

    return pptx.write({ outputType: 'nodebuffer' });
};

module.exports = { createPptBufferTci, PLACEHOLDER_WAREHOUSES };
