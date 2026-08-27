const PptxGenJS = require('pptxgenjs');

const { generateTitleSlide } = require('../slides/titleSlide');
const { generateIndexSlide } = require('../slides/indexSlide');
const { generateMainSlide } = require('../slides/mainSlide');
const { generateContactSlide } = require('../slides/contactSlide');

// Creates the complete presentation and returns it as a buffer
const createPptBuffer = async (warehouses, selectedImages, customDetails, includeLocation = false) => {
    let pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';

    generateTitleSlide(pptx, warehouses[0], customDetails);

    // Generate index slide after title slide and before warehouse detail slides
    generateIndexSlide(pptx, warehouses);

    // Generate all warehouse slides in parallel
    await Promise.all(
        warehouses.map((warehouse, index) => {
            const selectedWarehouseImages = selectedImages[warehouse.id] || [];
            const optionIndex = index + 1; // 1-based indexing for slide numbers
            return generateMainSlide(pptx, warehouse, selectedWarehouseImages, optionIndex, includeLocation);
        })
    );

    generateContactSlide(pptx, customDetails);

    // Generate and return the file buffer
    return await pptx.write('base64').then(base64 => Buffer.from(base64, 'base64'));
};

module.exports = {
    createPptBuffer
};
