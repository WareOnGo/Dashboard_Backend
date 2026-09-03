const { LAYOUT, COLORS, FONT, addSlideTitle } = require('./layoutV3');
const { addFooter, addTopRightLogo } = require('../v2/chromeV2');
const { fetchImage } = require('../../utils/image');
const { logWarn } = require('../../utils/logger');

/**
 * A CAD layout or floor plan, one drawing per slide.
 *
 * Drawings are not photographs and must not be treated like them. A photograph
 * survives cover-cropping — losing 20% of a shed's roofline costs nothing. A
 * layout cropped at all loses dimensions, a legend, or a whole bay, and the
 * numbers printed on it are the reason it is in the deck. So:
 *
 *   CONTAINED, NEVER COVERED. The entire drawing is on the slide, letterboxed
 *   against the page rather than filled to the edges.
 *
 *   ONE PER SLIDE. Two layouts side by side halves the linear scale, and a
 *   dimension string that is unreadable is the same as absent.
 *
 *   TURNED WHEN THAT MAKES IT BIGGER. A portrait A4 plan fits 3.18in wide upright
 *   and 6.36in on its side — twice the linear size, from a property of the page
 *   rather than anything about the drawing. The text ends up sideways, and that is
 *   an accepted trade: on a projected slide a legible sideways dimension beats an
 *   upright one nobody can make out. A reader can turn their head; they cannot
 *   zoom a projector.
 *
 *   The test is geometric rather than a guess at what "portrait" means: compute the
 *   scale each orientation achieves and take the larger. A 4:3 drawing gains
 *   nothing and is left alone; a tall one gains up to 2x. An aspect-ratio threshold
 *   would need an arbitrary cutoff and would be wrong either side of it.
 */

const REGION = {
    x: LAYOUT.MARGIN,
    y: LAYOUT.CONTENT_TOP,
    w: LAYOUT.CONTENT_W,
    h: LAYOUT.CONTENT_H,
};

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|svg)(?:$|\?)/i;
const isCadUrl = (url) => typeof url === 'string' && IMAGE_EXT_RE.test(url);

/**
 * Where to place a drawing of given natural dimensions, at the largest size that
 * crops nothing, turning it if that is bigger.
 *
 * pptxgenjs rotates about the shape's centre, so a turned drawing is positioned by
 * its UNROTATED box centred on the region — after turning, its footprint is that
 * box with the sides swapped. Which is why the box below can be taller than the
 * region it sits in: 4.50 x 6.36in becomes 6.36 x 4.50 once rotated.
 *
 * @param {number} w natural pixel width
 * @param {number} h natural pixel height
 * @param {object} [region]
 * @returns {{x:number,y:number,w:number,h:number,rotate:number,scaleGain:number}}
 */
function placeDrawing(w, h, region = REGION) {
    const upright = Math.min(region.w / w, region.h / h);
    const turned = Math.min(region.w / h, region.h / w);
    const rotate = turned > upright ? 90 : 0;
    const scale = Math.max(upright, turned);

    const boxW = w * scale;
    const boxH = h * scale;
    return {
        x: region.x + (region.w - boxW) / 2,
        y: region.y + (region.h - boxH) / 2,
        w: boxW,
        h: boxH,
        rotate,
        scaleGain: upright > 0 ? turned / upright : 1,
    };
}

/**
 * @param {object} pptx
 * @param {object} warehouse
 * @param {string[]} cadUrls
 * @param {number} optionIndex
 * @returns {Promise<number>} slides added
 */
async function generateCadSlidesV3(pptx, warehouse, cadUrls, optionIndex) {
    const urls = (cadUrls || []).filter(isCadUrl);
    if (!urls.length) return 0;

    let added = 0;
    for (const url of urls) {
        let fetched = null;
        try {
            // eslint-disable-next-line no-await-in-loop
            fetched = await fetchImage(url);
        } catch (err) {
            logWarn('cadSlideV3', 'generateCadSlidesV3', 'Could not fetch a layout drawing',
                { warehouseId: warehouse && warehouse.id, error: err && err.message });
        }
        // A slide holding a grey rectangle where a layout should be is worse than
        // no slide: it reads as a missing drawing rather than as a deck that never
        // had one. Photographs get a placeholder because they sit in a grid whose
        // other cells still carry meaning; a layout slide has nothing else on it.
        if (!fetched || !fetched.data) continue;

        const slide = pptx.addSlide();
        slide.background = { color: COLORS.bg };
        addSlideTitle(slide, urls.length > 1
            ? `Option ${optionIndex} - ID ${warehouse.id} — Layout (${added + 1} of ${urls.length})`
            : `Option ${optionIndex} - ID ${warehouse.id} — Layout`);

        const dims = fetched.dims;
        if (dims && dims.w > 0 && dims.h > 0) {
            const box = placeDrawing(dims.w, dims.h);
            slide.addImage({
                data: fetched.data,
                x: box.x, y: box.y, w: box.w, h: box.h,
                ...(box.rotate ? { rotate: box.rotate } : {}),
            });
        } else {
            // No dimensions to reason about, so fit the region and accept whatever
            // aspect distortion follows rather than dropping the drawing.
            slide.addImage({ data: fetched.data, ...REGION });
        }

        addTopRightLogo(slide);
        addFooter(slide);
        added += 1;
    }

    if (!added && urls.length) {
        logWarn('cadSlideV3', 'generateCadSlidesV3', 'Every layout drawing failed to load',
            { warehouseId: warehouse && warehouse.id, requested: urls.length });
    }
    return added;
}

module.exports = { generateCadSlidesV3, placeDrawing, isCadUrl, REGION };
