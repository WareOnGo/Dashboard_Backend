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
};

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
async function generatePhotosSlideV3(pptx, warehouse, selectedPhotoUrls, optionIndex) {
    const photos = (selectedPhotoUrls || []).filter(isImageUrl).slice(0, 4);
    if (photos.length === 0) return false;

    const slide = pptx.addSlide();
    slide.background = { color: COLORS.bg };
    addSlideTitle(slide, `Option ${optionIndex} - ID ${warehouse.id} — Photos`);

    const boxes = photoLayouts[photos.length]();
    await Promise.all(photos.map((url, i) => addImageOrPlaceholder(pptx, slide, url, boxes[i])));

    addTopRightLogo(slide);
    addFooter(slide);
    return true;
}

module.exports = { generatePhotosSlideV3, isImageUrl, gridBoxes, PHOTO_ASPECT };
