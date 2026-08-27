const PptxGenJS = require('pptxgenjs');

const { generateTitleSlideGodamwale } = require('../slides/godamwale/titleSlideGodamwale');
const { generateIndexSlideGodamwale } = require('../slides/godamwale/indexSlideGodamwale');
const { generateDetailedSlideGodamwale } = require('../slides/godamwale/detailedSlideGodamwale');

const createPptBufferGodamwale = async (warehouses, selectedImages = {}, customDetails = {}) => {
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_16x9';

    await generateTitleSlideGodamwale(pptx, warehouses, customDetails);
    generateIndexSlideGodamwale(pptx, warehouses);

    for (let i = 0; i < warehouses.length; i++) {
        const w = warehouses[i];
        const photos = selectedImages[w.id] || [];
        await generateDetailedSlideGodamwale(pptx, w, photos, i + 1);
    }

    return pptx.write({ outputType: 'nodebuffer' });
};

module.exports = { createPptBufferGodamwale };
