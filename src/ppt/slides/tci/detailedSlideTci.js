const { COLORS, LAYOUT, FONT } = require('./themeTci');
const { addOptionSlideChrome } = require('./chromeTci');
const { fetchImage } = require('../../utils/image');
const { propertyFields } = require('../propertyFields');

const MAX_CELL_CHARS = 110;
const clamp = (s) => {
    if (s == null) return '';
    const str = String(s);
    return str.length <= MAX_CELL_CHARS ? str : str.slice(0, MAX_CELL_CHARS - 1).trimEnd() + '…';
};

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp)(?:$|\?)/i;
const isImageUrl = (url) => typeof url === 'string' && IMAGE_EXT_RE.test(url);

const addImageOrPlaceholder = async (pptx, slide, url, box) => {
    if (!url) {
        slide.addShape('rect', { ...box, fill: { color: 'EFEFEF' }, line: { color: 'D0D0D0', width: 0.5 } });
        return;
    }
    try {
        const { data, dims } = await fetchImage(url);
        if (dims && dims.w > 0 && dims.h > 0) {
            // Scale source pixel dims to inches preserving aspect; the absolute
            // size is irrelevant because pptxgenjs's `cover` only uses the
            // ratio, and the placement gets clamped to `sizing.w/h` afterwards.
            const sourceAspect = dims.w / dims.h;
            const topW = 10, topH = 10 / sourceAspect;
            slide.addImage({
                data,
                x: box.x, y: box.y, w: topW, h: topH,
                sizing: { type: 'cover', w: box.w, h: box.h, x: 0, y: 0 },
            });
        } else {
            // No dimensions available — fall back to the previous behavior so
            // we at least render something rather than throwing.
            slide.addImage({ data, ...box, sizing: { type: 'cover', w: box.w, h: box.h } });
        }
    } catch (_) {
        slide.addShape('rect', { ...box, fill: { color: 'EFEFEF' }, line: { color: 'D0D0D0', width: 0.5 } });
    }
};

/**
 * Photographs get the whole content box on their own slide.
 *
 * Every cell is one quarter of that box, so a cell's aspect (~1.67) matches the
 * box's own — meaning no arrangement crops a landscape photo harder than any
 * other. Fewer than four photos use the same cells and centre what they have
 * vertically, rather than stretching two photos over an area shaped for four.
 */
const PHOTO_REGION = {
    x: LAYOUT.MARGIN,
    y: LAYOUT.CONTENT_TOP,
    w: LAYOUT.CONTENT_W,
    h: LAYOUT.CONTENT_H,
};
const GAP = 0.12;

const CELL_W = (PHOTO_REGION.w - GAP) / 2;
const CELL_H = (PHOTO_REGION.h - GAP) / 2;

/** Rows of cells, centred vertically in the region. */
const gridRows = (counts) => {
    const rowCount = counts.length;
    const totalH = rowCount * CELL_H + (rowCount - 1) * GAP;
    const top = PHOTO_REGION.y + (PHOTO_REGION.h - totalH) / 2;

    return counts.flatMap((inRow, rowIndex) => {
        const y = top + rowIndex * (CELL_H + GAP);
        const rowW = inRow * CELL_W + (inRow - 1) * GAP;
        const left = PHOTO_REGION.x + (PHOTO_REGION.w - rowW) / 2;
        return Array.from({ length: inRow }, (_, i) => ({
            x: left + i * (CELL_W + GAP), y, w: CELL_W, h: CELL_H,
        }));
    });
};

const photoLayouts = {
    // A lone photo takes the full box, which has the same shape as a cell.
    1: () => [{ ...PHOTO_REGION }],
    2: () => gridRows([2]),
    3: () => gridRows([2, 1]),
    4: () => gridRows([2, 2]),
};

/** Place the photographs. Callers must pass at least one. */
const layoutPhotos = async (pptx, slide, photos) => {
    if (photos.length === 0) return;
    const boxes = photoLayouts[Math.min(photos.length, 4)]();
    await Promise.all(photos.slice(0, 4).map((url, i) => addImageOrPlaceholder(pptx, slide, url, boxes[i])));
};

/** Title + chrome, shared by both of an option's slides. */
function startOptionSlide(pptx, optionIndex, subtitle) {
    const slide = pptx.addSlide();
    slide.background = { color: COLORS.bg };

    slide.addText(`${optionIndex}. Option ${optionIndex} – ${subtitle}`, {
        x: 0.32, y: 0.38, w: 7.0, h: 0.55,
        fontFace: FONT, fontSize: 22, bold: true, color: COLORS.text,
    });

    addOptionSlideChrome(slide);
    return slide;
}

/**
 * An option's photographs, on their own slide.
 *
 * Carries the same "Option N" title as the details slide it precedes, so a
 * reader landing on it knows which property they are looking at.
 *
 * Adds nothing when the property has no usable photograph — a slide holding only
 * a "not available" note reads as an unfinished deck, and this one goes to
 * clients. That also drops the template's old "can be provided upon request"
 * copy, which only ever existed to fill the right-hand column of the combined
 * slide. Deciding here rather than in the caller keeps "what counts as a
 * photograph" in one place.
 *
 * @returns {Promise<boolean>} whether a slide was added
 */
async function generatePhotosSlideTci(pptx, warehouse, selectedPhotoUrls, optionIndex) {
    const imagePhotos = (selectedPhotoUrls || []).filter(isImageUrl).slice(0, 4);
    if (imagePhotos.length === 0) return false;

    const slide = startOptionSlide(pptx, optionIndex, 'Photos');
    await layoutPhotos(pptx, slide, imagePhotos);
    return true;
}

/**
 * An option's specification table, full width.
 *
 * The table used to share the slide with the photographs, taking the left half;
 * the photographs now have their own slide, so it spans the content box.
 */
async function generateDetailedSlideTci(pptx, warehouse, selectedPhotoUrls, optionIndex, flags = {}) {
    const slide = startOptionSlide(pptx, optionIndex, 'Property Details');

    // Field derivation lives in ../propertyFields so the v3 deck renders exactly
    // the same columns; this function only styles them.
    const rows = propertyFields(warehouse, flags);

    // Header rows reproduce the source's dark navy "Project name" band plus
    // the white "Building Structural Details" sub-header.
    const headerCellOpts = {
        bold: true, color: COLORS.textInverse, fill: { color: COLORS.headerBg },
        fontFace: FONT, fontSize: 12, valign: 'middle', margin: 0.06,
    };
    const subHeaderOpts = {
        bold: true, color: COLORS.text, fontFace: FONT, fontSize: 11,
        valign: 'middle', margin: 0.06,
    };
    const labelOpts = {
        color: COLORS.text, fontFace: FONT, fontSize: 10,
        valign: 'middle', margin: 0.06,
    };
    const valueOpts = {
        color: COLORS.text, fontFace: FONT, fontSize: 10,
        valign: 'middle', margin: 0.06,
    };

    const cells = rows.map((row) => {
        if (row.kind === 'header') {
            return [
                { text: row.label, options: headerCellOpts },
                { text: row.value, options: headerCellOpts },
            ];
        }
        if (row.kind === 'subheader') {
            return [{ text: row.label, options: { ...subHeaderOpts, colspan: 2 } }];
        }
        const valueCell = row.url
            ? { text: row.value, options: { ...valueOpts, hyperlink: { url: row.url }, color: COLORS.hyperlink, underline: { style: 'sng' } } }
            : { text: clamp(row.value ?? 'N/A'), options: valueOpts };
        return [{ text: row.label, options: labelOpts }, valueCell];
    });

    // Label column widened with the extra room: "Building Stability Certificate"
    // wrapped to two lines at the old 1.85".
    const LABEL_W = 2.60;
    slide.addTable(cells, {
        x: LAYOUT.MARGIN, y: LAYOUT.CONTENT_TOP, w: LAYOUT.CONTENT_W,
        colW: [LABEL_W, LAYOUT.CONTENT_W - LABEL_W],
        rowH: 0.27,
        border: { type: 'solid', pt: 0.5, color: COLORS.border },
    });
}

module.exports = { generateDetailedSlideTci, generatePhotosSlideTci };
