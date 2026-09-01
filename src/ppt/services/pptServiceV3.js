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
const { fetchOverviewMap, generateMapSlideV3 } = require('../slides/v3/mapSlideV3');
const { fetchDistanceComparison, generateDistanceSlideV3 } = require('../slides/v3/distanceSlideV3');
const { fetchSiteMaps, generateProximitySlideV3 } = require('../slides/v3/proximitySlideV3');

// Where the overview map belongs: after the cover and the index, so the reader
// sees the geography before the individual options.
const MAP_SLIDE_POSITION = 2;

/**
 * Re-sync each slide's relationship id with its position in the deck.
 *
 * pptxgenjs writes the slide files and `presentation.xml.rels` from the array's
 * order, but writes `sldIdLst` — the list that actually determines slide order —
 * from each slide's `_rId`, which was assigned when the slide was created. Move a
 * slide without fixing that and the two disagree: the deck opens with slides in
 * an order matching neither, which is how this was first caught (LibreOffice
 * rendered the last photos slide third).
 *
 * `_slideNum` is deliberately left alone: media filenames were baked from it at
 * addImage time, so renumbering it would orphan every image.
 */
function renumberSlideRelationships(pptx) {
    // rId1 is the slide master, so slides start at 2 — matching
    // makeXmlPresentationRels, which numbers them the same way.
    pptx.slides.forEach((slide, index) => { slide._rId = index + 2; });
}

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

    // Started before anything is drawn and awaited after the property loop, so a
    // request that takes a second or two runs alongside the photo downloads
    // instead of adding itself to the total. Never rejects — a deck without its
    // map is a lesser deck, not a failed one.
    const mapPending = fetchOverviewMap(warehouses, flags);
    // Same treatment: routing every option against the client's own site is a
    // handful of requests, all started here so they run while the photographs
    // download rather than after them.
    const distancePending = fetchDistanceComparison(warehouses, customDetails, flags);
    // One street map per warehouse for the connectivity slides. Fired here so the
    // images download alongside the photographs rather than after them; the
    // distances themselves are already in the database and cost nothing.
    const siteMapsPending = fetchSiteMaps(warehouses, flags);

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
        // Connectivity follows the photographs, so each option reads as
        // specification -> photographs -> where it sits.
        // Awaiting the same promise each pass is free after the first: only the
        // first option waits, and by then its photographs have already downloaded.
        // Awaiting before the loop would have serialised the maps ahead of every
        // photograph instead.
        const siteMaps = await siteMapsPending;
        generateProximitySlideV3(pptx, w, i + 1, siteMaps.get(w.id) || null);
    }

    const map = await mapPending;
    if (map) {
        // Built last so its fetch could overlap the photographs, then moved into
        // place after the index.
        const slide = generateMapSlideV3(pptx, map);
        pptx.slides.pop();
        pptx.slides.splice(MAP_SLIDE_POSITION, 0, slide);
        renumberSlideRelationships(pptx);
    }

    // Placed before the closing contact slide, which stays the deck's sign-off.
    const distance = await distancePending;
    if (distance) generateDistanceSlideV3(pptx, distance);

    if (flags.pocSlide) {
        generateContactSlideV2(pptx, customDetails);
    }

    return pptx.write({ outputType: 'nodebuffer' });
};

module.exports = { createPptBufferV3 };
