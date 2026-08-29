const PptxGenJS = require('pptxgenjs');

// v3 is the v2 deck with a fuller specification table and the photographs moved
// onto their own slide. Its cover, index and closing slides ARE v2's — imported
// rather than copied, so the branding cannot drift between the two decks and a
// fix to one (the index slide's commercials redaction, say) lands in both. Fork
// a module here only when v3 is meant to look different, not merely because it
// is a different deck.
const { generateTitleSlideV2 } = require('../slides/v2/titleSlideV2');
const { generateIndexSlideV2 } = require('../slides/v2/indexSlideV2');
const { generateContactSlideV2 } = require('../slides/v2/contactSlideV2');

const { generateDetailedSlideV3 } = require('../slides/v3/detailedSlideV3');
const { generatePhotosSlideV3 } = require('../slides/v3/photosSlideV3');

const createPptBufferV3 = async (warehouses, selectedImages = {}, customDetails = {}) => {
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_16x9';

    // Same display flags as v2, with the same defaults, so a caller can switch
    // between the two decks without changing anything else:
    //   commercials  -> rent shows "Available on Demand" (index slide included)
    //   mapsLocation -> Google coordinates show "Available on Demand"
    //   pocSlide     -> the closing WareOnGo POC slide is omitted
    const flags = {
        commercials: customDetails.commercials !== false,
        mapsLocation: customDetails.mapsLocation !== false,
        pocSlide: customDetails.pocSlide !== false,
    };

    await generateTitleSlideV2(pptx, warehouses, customDetails);
    generateIndexSlideV2(pptx, warehouses, flags);

    for (let i = 0; i < warehouses.length; i++) {
        const w = warehouses[i];
        const photos = selectedImages[w.id] || [];
        // The specification table, then the photographs — the latter only when
        // there are any, so a property without photographs contributes one slide
        // rather than one plus an empty one.
        await generateDetailedSlideV3(pptx, w, photos, i + 1, flags);
        await generatePhotosSlideV3(pptx, w, photos, i + 1);
    }

    if (flags.pocSlide) {
        generateContactSlideV2(pptx, customDetails);
    }

    return pptx.write({ outputType: 'nodebuffer' });
};

module.exports = { createPptBufferV3 };
