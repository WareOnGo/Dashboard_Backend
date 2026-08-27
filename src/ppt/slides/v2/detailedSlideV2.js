const { COLORS, FONT } = require('./themeV2');
const { addFooter, addTopRightLogo } = require('./chromeV2');
const { fetchImage } = require('../../utils/image');
const { formatHandover } = require('../../utils/handover');

const SIDEBAR_W = 2.85;
const SLIDE_H = 5.625;
const TABLE_X = 0.15;
const TABLE_W = 2.62;
const LABEL_COL_W = 0.82;
const VALUE_COL_W = TABLE_W - LABEL_COL_W;

const sectionLabel = (slide, text, y) => {
    slide.addText(text, {
        x: 0.089, y, w: 2.25, h: 0.35,
        fontFace: FONT, fontSize: 10, bold: true, color: COLORS.navy,
    });
};

// Specific Montserrat weights — pptxgenjs passes fontFace through verbatim,
// so to hit ExtraBold / SemiBold we name the weight in the face string.
const FONT_EXTRABOLD = `${FONT} ExtraBold`;
const FONT_SEMIBOLD = `${FONT} SemiBold`;

// Rich-text fragment values (e.g. hyperlinks) come in as `{ runs: [...] }` and
// are passed through to pptxgenjs verbatim — clamp/stringify only plain values.
const isRichValue = (v) => v != null && typeof v === 'object' && Array.isArray(v.runs);
const cellText = (v) => (isRichValue(v) ? v.runs : clamp(v ?? 'N/A'));

const buildTable = (slide, rows, y, threeCol = false) => {
    const labelOpts = { bold: true, color: COLORS.bg, fill: { color: COLORS.navy }, fontFace: FONT_SEMIBOLD, fontSize: 7, valign: 'middle', margin: 0.05 };
    const valueOpts = { color: COLORS.navy, fill: { color: COLORS.sidebar }, fontFace: FONT, fontSize: 7, valign: 'middle', margin: 0.05 };
    const cells = rows.map(([label, value]) => {
        if (threeCol && Array.isArray(value)) {
            return [
                { text: label, options: labelOpts },
                { text: cellText(value[0]), options: valueOpts },
                { text: cellText(value[1]), options: valueOpts },
            ];
        }
        if (threeCol) {
            return [
                { text: label, options: labelOpts },
                { text: cellText(value), options: { ...valueOpts, colspan: 2 } },
            ];
        }
        return [
            { text: label, options: labelOpts },
            { text: cellText(value), options: valueOpts },
        ];
    });
    const colW = threeCol ? [LABEL_COL_W, 0.95, 0.85] : [LABEL_COL_W, VALUE_COL_W];
    const rowH = rowHeights(rows, colW);
    slide.addTable(cells, {
        x: TABLE_X, y, w: TABLE_W,
        colW,
        rowH,
        border: { type: 'solid', pt: 0.5, color: COLORS.divider },
    });
    return rowH.reduce((s, h) => s + h, 0);
};

const splitInTwo = (str) => {
    if (!str) return null;
    const parts = String(str).split(/\s*,\s*/).filter(Boolean);
    return parts.length === 2 ? parts : null;
};

// Approximate row height for a table at fontSize 7pt with given column widths.
// We don't have a metrics engine, so use chars-per-inch heuristic.
const CHAR_W = 0.058;
const LINE_H = 0.1425;
const ROW_PAD = 0.171;
const MIN_ROW_H = 0.2565;
const MAX_CELL_CHARS = 70;

const clamp = (text) => {
    if (text == null) return text;
    const s = String(text);
    return s.length <= MAX_CELL_CHARS ? s : s.slice(0, MAX_CELL_CHARS - 1).trimEnd() + '…';
};

const plainText = (v) => {
    if (v == null) return '';
    if (isRichValue(v)) return v.runs.map((r) => r.text || '').join('');
    return String(v);
};

const linesForCell = (text, colW) => {
    if (!text) return 1;
    const usable = Math.max(colW - 0.1, 0.1);
    const charsPerLine = Math.max(Math.floor(usable / CHAR_W), 1);
    return Math.max(Math.ceil(String(text).length / charsPerLine), 1);
};

// Per-row heights matching our line-count heuristic. We feed these to
// pptxgenjs via `rowH` so the rendered table height equals the sum we
// compute here — no drift between estimate and what LibreOffice draws.
const rowHeights = (rows, colWidths) => rows.map(([label, value]) => {
    let maxLines = linesForCell(label, colWidths[0]);
    if (Array.isArray(value)) {
        maxLines = Math.max(maxLines, linesForCell(clamp(plainText(value[0])), colWidths[1]), linesForCell(clamp(plainText(value[1])), colWidths[2]));
    } else {
        const valColW = (colWidths[1] || 0) + (colWidths[2] || 0);
        maxLines = Math.max(maxLines, linesForCell(clamp(plainText(value)), valColW));
    }
    return Math.max(maxLines * LINE_H + ROW_PAD, MIN_ROW_H);
});

// Photo arrays in the DB sometimes mix in video uploads (.mp4, .mov). pptxgenjs
// will happily fetch the bytes and call addImage on them, producing a blank
// tile. Strip anything that isn't an image extension before layout.
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp)(?:$|\?)/i;
const isImageUrl = (url) => typeof url === 'string' && IMAGE_EXT_RE.test(url);

const addImageOrPlaceholder = async (pptx, slide, url, box) => {
    if (!url) {
        slide.addShape(pptx.shapes.RECTANGLE, { ...box, fill: { color: COLORS.sidebar }, line: { color: COLORS.divider, width: 0.5 } });
        return;
    }
    try {
        const { data, dims } = await fetchImage(url);
        if (dims && dims.w > 0 && dims.h > 0) {
            const sourceAspect = dims.w / dims.h;
            const topW = 10, topH = 10 / sourceAspect;
            slide.addImage({
                data,
                x: box.x, y: box.y, w: topW, h: topH,
                sizing: { type: 'cover', w: box.w, h: box.h, x: 0, y: 0 },
            });
        } else {
            slide.addImage({ data, ...box, sizing: { type: 'cover', w: box.w, h: box.h } });
        }
    } catch (e) {
        slide.addShape(pptx.shapes.RECTANGLE, { ...box, fill: { color: COLORS.sidebar }, line: { color: COLORS.divider, width: 0.5 } });
    }
};

const REGION = { x: 2.9, y: 0.4, w: 6.65, h: 4.75 };
const GAP = 0.15;

const photoLayouts = {
    1: () => [{ x: 2.904, y: 0.931, w: 6.654, h: 3.621 }],
    2: () => {
        // Landscape tiles (~1.35 aspect) so cover-cropping a typical 4:3
        // listing photo only trims a sliver vs. a portrait box which would
        // crop half the image and look smushed.
        const w = (REGION.w - GAP) / 2;
        const h = 2.4;
        const y = REGION.y + (REGION.h - h) / 2;
        return [
            { x: REGION.x, y, w, h },
            { x: REGION.x + w + GAP, y, w, h },
        ];
    },
    3: () => {
        const topH = 2.4;
        const botH = REGION.h - topH - GAP;
        const botW = (REGION.w - GAP) / 2;
        const botY = REGION.y + topH + GAP;
        return [
            { x: REGION.x, y: REGION.y, w: REGION.w, h: topH },
            { x: REGION.x, y: botY, w: botW, h: botH },
            { x: REGION.x + botW + GAP, y: botY, w: botW, h: botH },
        ];
    },
    4: () => {
        const tile = { w: 3.176, h: 2.29 };
        return [
            { x: 2.927, y: 0.358, ...tile },
            { x: 6.344, y: 0.358, ...tile },
            { x: 2.927, y: 2.86, ...tile },
            { x: 6.344, y: 2.86, ...tile },
        ];
    },
};

const layoutPhotos = async (pptx, slide, photos) => {
    if (photos.length === 0) {
        // No box / no fill — just the message, so the empty area reads as
        // intentional whitespace instead of a missing-image placeholder.
        slide.addText('Photos not available.\nCan be provided upon request.', {
            ...REGION, fontFace: FONT, fontSize: 14, color: '808080', align: 'center', valign: 'middle',
        });
        return;
    }
    const boxes = photoLayouts[photos.length]();
    await Promise.all(photos.map((url, i) => addImageOrPlaceholder(pptx, slide, url, boxes[i])));
};

async function generateDetailedSlideV2(pptx, warehouse, selectedPhotoUrls, optionIndex, flags = {}) {
    // Display flags default to true (show real data). When false, the field is
    // redacted to "Available on Demand".
    const showCommercials = flags.commercials !== false;
    const showMapsLocation = flags.mapsLocation !== false;
    const slide = pptx.addSlide();
    slide.background = { color: COLORS.bg };

    slide.addShape(pptx.shapes.RECTANGLE, {
        x: 0, y: 0, w: SIDEBAR_W, h: SLIDE_H,
        fill: { color: COLORS.sidebar },
        line: { color: COLORS.sidebar, width: 0 },
    });

    // Thin vertical divider between the sidebar (tables) and the photos area —
    // matches the separator in the reference deck. Drawn as a zero-width line
    // from top to bottom of the slide at the sidebar's right edge.
    slide.addShape(pptx.shapes.LINE, {
        x: SIDEBAR_W, y: 0, w: 0, h: SLIDE_H,
        line: { color: COLORS.divider, width: 0.5 },
    });

    slide.addText(`Option ${optionIndex} - ID ${warehouse.id}`, {
        x: 0.089, y: 0.078, w: 2.45, h: 0.491,
        fontFace: FONT_EXTRABOLD, fontSize: 13, bold: true, color: COLORS.navy,
    });

    // Section spacing is driven by two constants so the layout reads as a
    // single rhythm: label, table, gap, label, table, gap, ...
    const LABEL_TO_TABLE = 0.304;  // distance from a section label to its table
    const TABLE_TO_LABEL = 0.096;  // distance from end of a table to the next label
    // Visual nudge: shift labels up by 10% of LABEL_TO_TABLE without moving
    // the tables — preserves every other gap in the rhythm.
    const LABEL_LIFT = LABEL_TO_TABLE * 0.1;

    const locationLabelY = 0.5;
    sectionLabel(slide, 'Location Details', locationLabelY - LABEL_LIFT);
    const locationLabel = warehouse.address || [warehouse.city, warehouse.state].filter(Boolean).join(', ') || 'N/A';
    const lat = warehouse.WarehouseData?.latitude;
    const lng = warehouse.WarehouseData?.longitude;
    const hasCoords = typeof lat === 'number' && typeof lng === 'number';
    // Link target: prefer the saved googleLocation URL (the specific place the
    // team mapped). Only synthesize a coords-search URL if no saved URL exists.
    const mapsUrl = warehouse.googleLocation
        || (hasCoords ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}` : null);
    // Display text: lat/long when we have coords, otherwise "See link".
    const mapsText = hasCoords ? `${lat}, ${lng}` : 'See link';
    const mapsValue = (showMapsLocation && mapsUrl)
        ? { runs: [{ text: mapsText, options: { hyperlink: { url: mapsUrl }, color: '1A56DB', underline: { style: 'sng' } } }] }
        : 'Available on Demand';
    const propertyRows = [
        ['Address', locationLabel],
        ['Google Maps', mapsValue],
    ];
    const locationTableY = locationLabelY + LABEL_TO_TABLE;
    const locationHeight = buildTable(slide, propertyRows, locationTableY);

    const specsLabelY = locationTableY + locationHeight + TABLE_TO_LABEL;
    const specsTableY = specsLabelY + LABEL_TO_TABLE;
    sectionLabel(slide, 'Specifications', specsLabelY - LABEL_LIFT);
    const area = Array.isArray(warehouse.totalSpaceSqft) && warehouse.totalSpaceSqft.length
        ? `${warehouse.totalSpaceSqft.join(', ')} sqft`
        : (warehouse.offeredSpaceSqft || 'N/A');
    const wd = warehouse.WarehouseData || {};
    const yn = (v) => (v ? 'Y' : 'N');
    const landTypeStr = (wd.landType || '').trim();
    const isUnverifiedCLU = !landTypeStr || /^others?$/i.test(landTypeStr);
    const cluValue = isUnverifiedCLU ? 'Unverified CLU' : `${landTypeStr} CLU`;
    const fireNocValue = `Fire NOC - ${yn(wd.fireNocAvailable)}`;

    // Two-cell rows now pull from dedicated schema columns instead of
    // splitting a single comma-separated string. Suffixes disambiguate the
    // two cells (e.g. "4ft plinth height" vs "3 Nos.") so the row reads
    // clearly even when only one value is present.
    const pair = (a, b) => (a || b) ? [a || 'N/A', b || 'N/A'] : null;
    const withSuffix = (v, suffix) => (v ? `${v} ${suffix}` : null);
    const docksValue = pair(warehouse.numberOfDocks, withSuffix(warehouse.plinthHeightFt, 'plinth height'))
        || splitInTwo(warehouse.numberOfDocks)
        || warehouse.numberOfDocks
        || 'N/A';
    const heightValue = pair(withSuffix(warehouse.clearHeightFt, 'eaves'), withSuffix(warehouse.centreHeight, 'centre'))
        || splitInTwo(warehouse.clearHeightFt)
        || warehouse.clearHeightFt
        || 'N/A';
    const flooringValue = [warehouse.flooringType || 'Unverified', warehouse.floorStrengthPerSqm || 'Unverified'];

    const specRows = [
        ['Offered Area', area],
        ['Building', warehouse.warehouseType || 'N/A'],
        ['Docks', docksValue],
        ['Height', heightValue],
        ['Flooring', flooringValue],
        ['Fire Safety', wd.fireSafetyMeasures || 'N/A'],
        ['Compliances', [cluValue, fireNocValue]],
        ['Handover', formatHandover(warehouse)],
    ];
    const specsHeight = buildTable(slide, specRows, specsTableY, true);

    const commercialsLabelY = specsTableY + specsHeight + TABLE_TO_LABEL;
    sectionLabel(slide, 'Commercials', commercialsLabelY - LABEL_LIFT);
    const commercialRows = [
        ['Rent per sq.ft (INR)', showCommercials ? (warehouse.ratePerSqft || 'On request') : 'Available on Demand'],
    ];
    buildTable(slide, commercialRows, commercialsLabelY + LABEL_TO_TABLE);

    const imagePhotos = (selectedPhotoUrls || []).filter(isImageUrl).slice(0, 4);
    await layoutPhotos(pptx, slide, imagePhotos);

    addTopRightLogo(slide);
    addFooter(slide);
}

module.exports = { generateDetailedSlideV2 };
