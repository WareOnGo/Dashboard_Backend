const { LAYOUT, COLORS, addSlideTitle } = require('./layoutV3');
const { addFooter, addTopRightLogo } = require('../v2/chromeV2');
const { fetchImage } = require('../../utils/image');

/**
 * An option's photographs, on their own slide.
 *
 * The cell aspect is fixed rather than derived from the region: a 16:9 slide's
 * content box is about 2.1 wide-to-tall, and cover-cropping a 4:3 listing photo
 * into a cell that shape throws away nearly 40% of its height — enough to cut a
 * roofline off. Cells are held at 1.6 and the grid is centred instead, so every
 * arrangement crops by the same modest amount.
 */
const PHOTO_ASPECT = 1.6;

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp)(?:$|\?)/i;
const isImageUrl = (url) => typeof url === 'string' && IMAGE_EXT_RE.test(url);

const REGION = {
    x: LAYOUT.MARGIN,
    y: LAYOUT.CONTENT_TOP,
    w: LAYOUT.CONTENT_W,
    h: LAYOUT.CONTENT_H,
};

/**
 * Boxes for a grid described as cells-per-row, e.g. [2, 1] for three
 * photographs. Cells are sized to the tighter of the height and width budgets so
 * the whole grid fits, then centred in both axes.
 */
function gridBoxes(rowCounts) {
    const gap = LAYOUT.GUTTER;
    const rows = rowCounts.length;
    const widest = Math.max(...rowCounts);

    let cellH = (REGION.h - (rows - 1) * gap) / rows;
    let cellW = cellH * PHOTO_ASPECT;

    const maxW = (REGION.w - (widest - 1) * gap) / widest;
    if (cellW > maxW) {
        cellW = maxW;
        cellH = cellW / PHOTO_ASPECT;
    }

    const gridH = rows * cellH + (rows - 1) * gap;
    const top = REGION.y + (REGION.h - gridH) / 2;

    return rowCounts.flatMap((count, rowIndex) => {
        const y = top + rowIndex * (cellH + gap);
        const rowW = count * cellW + (count - 1) * gap;
        const left = REGION.x + (REGION.w - rowW) / 2;
        return Array.from({ length: count }, (_, i) => ({
            x: left + i * (cellW + gap), y, w: cellW, h: cellH,
        }));
    });
}

const photoLayouts = {
    1: () => gridBoxes([1]),
    2: () => gridBoxes([2]),
    3: () => gridBoxes([2, 1]),
    4: () => gridBoxes([2, 2]),
    5: () => gridBoxes([3, 2]),
    6: () => gridBoxes([3, 3]),
};

/**
 * Photographs per slide.
 *
 * Six fits: three across gives a 2.96in cell, 1.85in tall at the fixed 1.6 aspect,
 * so two rows come to 3.9in inside a 4.5in content box. Seven would need a third
 * row and each photograph would be smaller than a thumbnail.
 */
const MAX_PER_SLIDE = 6;

/**
 * Split n photographs into balanced slides.
 *
 * Balanced rather than greedy: eight photographs go 4+4, not 6+2. Filling the
 * first slide and leaving two adrift on the second looks like a mistake, and the
 * grid is centred either way so there is nothing to gain from packing.
 *
 * @param {number} n
 * @param {number} [max]
 * @returns {number[]} how many photographs go on each slide
 */
function chunkSizes(n, max = MAX_PER_SLIDE) {
    if (n <= 0) return [];
    const slides = Math.ceil(n / max);
    const base = Math.floor(n / slides);
    const extra = n % slides;
    return Array.from({ length: slides }, (_, i) => base + (i < extra ? 1 : 0));
}

const addImageOrPlaceholder = async (pptx, slide, url, box) => {
    const placeholder = () => slide.addShape(pptx.shapes.RECTANGLE, {
        ...box, fill: { color: COLORS.sidebar }, line: { color: COLORS.divider, width: 0.5 },
    });
    if (!url) return placeholder();
    try {
        const { data, dims } = await fetchImage(url);
        if (dims && dims.w > 0 && dims.h > 0) {
            // pptxgenjs's `cover` reads the aspect from the top-level w/h, so
            // those carry the source's true ratio while `sizing` pins placement.
            const sourceAspect = dims.w / dims.h;
            slide.addImage({
                data,
                x: box.x, y: box.y, w: 10, h: 10 / sourceAspect,
                sizing: { type: 'cover', w: box.w, h: box.h, x: 0, y: 0 },
            });
        } else {
            slide.addImage({ data, ...box, sizing: { type: 'cover', w: box.w, h: box.h } });
        }
    } catch (_) {
        placeholder();
    }
};

/**
 * @returns {Promise<boolean>} whether a slide was added — a property with no
 *   usable photograph gets none, rather than one holding only a note.
 */
/**
 * @returns {Promise<number>} how many slides were added. Was a boolean when four
 *   photographs were the ceiling; a caller only ever tested it for truthiness, and
 *   a count is still falsy at zero.
 */
async function generatePhotosSlideV3(pptx, warehouse, selectedPhotoUrls, optionIndex) {
    // No cap. The four-photograph limit was a layout limit — there were only four
    // grids — and a client with eight photographs of a shed should get eight.
    const photos = (selectedPhotoUrls || []).filter(isImageUrl);
    if (photos.length === 0) return 0;

    const sizes = chunkSizes(photos.length);
    let taken = 0;

    for (let slideIndex = 0; slideIndex < sizes.length; slideIndex += 1) {
        const batch = photos.slice(taken, taken + sizes[slideIndex]);
        taken += batch.length;

        const slide = pptx.addSlide();
        slide.background = { color: COLORS.bg };
        addSlideTitle(slide, sizes.length > 1
            ? `Option ${optionIndex} - ID ${warehouse.id} — Photos (${slideIndex + 1} of ${sizes.length})`
            : `Option ${optionIndex} - ID ${warehouse.id} — Photos`);

        const boxes = photoLayouts[batch.length]();
        // eslint-disable-next-line no-await-in-loop
        await Promise.all(batch.map((url, i) => addImageOrPlaceholder(pptx, slide, url, boxes[i])));

        addTopRightLogo(slide);
        addFooter(slide);
    }

    return sizes.length;
}

module.exports = {
    generatePhotosSlideV3, isImageUrl, gridBoxes, chunkSizes, PHOTO_ASPECT, MAX_PER_SLIDE,
};
