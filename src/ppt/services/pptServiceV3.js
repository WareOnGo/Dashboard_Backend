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
const { generateProsConsSlideV3 } = require('../slides/v3/prosConsSlideV3');
const { generateCadSlidesV3 } = require('../slides/v3/cadSlideV3');

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

/**
 * Split one warehouse's selection into photographs and layout drawings.
 *
 * `selectedImages[id]` accepts two shapes, because v2, godamwale and the detailed
 * deck all still send the first and there is no reason to break them:
 *
 *   ['url', ...]                          every image is a photograph
 *   { photos: ['url'], cad: ['url'] }     drawings called out separately
 *
 * A drawing has to be designated rather than detected. The image classifier's
 * DOCUMENT label covers CAD drawings AND khata extracts, tax receipts and rent
 * agreements, so treating DOCUMENT as "layout" would put a client's paperwork on a
 * slide titled Layout. Only the person choosing the images knows which is which.
 */
function splitSelection(entry) {
    // `classified` records which shape it was, because the detail slide's
    // photograph strip must not crop a document. In the object shape `photos` is
    // known to hold photographs only; in the flat array a khata extract and a
    // shed are indistinguishable at that layer.
    if (Array.isArray(entry)) return { photos: entry, cad: [], classified: false };
    if (entry && typeof entry === 'object') {
        return {
            photos: Array.isArray(entry.photos) ? entry.photos : [],
            cad: Array.isArray(entry.cad) ? entry.cad : [],
            classified: true,
        };
    }
    return { photos: [], cad: [], classified: false };
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
        const { photos, cad, classified } = splitSelection(selectedImages[w.id]);
        // The specification table, then the photographs — the latter only when
        // there are any, so a property without photographs contributes one slide
        // rather than one plus an empty one.
        await generateDetailedSlideV3(pptx, w, photos, i + 1, flags, classified);
        await generatePhotosSlideV3(pptx, w, photos, i + 1);
        // Layouts follow the photographs: a reader has seen the building before
        // being asked to read a plan of it.
        await generateCadSlidesV3(pptx, w, cad, i + 1);
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

    // The closing argument, and the one slide we cannot fill in: which trade-offs
    // matter depends on the client's requirement. Ships as a structured blank with a
    // row per property, immediately before the sign-off so it is the last thing
    // discussed. Paginates past 12 properties rather than shrinking rows below the
    // height of the text someone has to type into them.
    generateProsConsSlideV3(pptx, warehouses);

    if (flags.pocSlide) {
        generateContactSlideV2(pptx, customDetails);
    }

    return pptx.write({ outputType: 'nodebuffer' });
};

module.exports = { createPptBufferV3, splitSelection };
