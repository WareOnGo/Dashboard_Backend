const { COLORS, LAYOUT, FONT } = require('./themeTci');
const { addOptionSlideChrome } = require('./chromeTci');
const { fetchImage } = require('../../utils/image');

const MAX_CELL_CHARS = 110;
const clamp = (s) => {
    if (s == null) return '';
    const str = String(s);
    return str.length <= MAX_CELL_CHARS ? str : str.slice(0, MAX_CELL_CHARS - 1).trimEnd() + '…';
};

// Treat empty strings and the literal placeholders "NA" / "N/A" as null —
// they show up across the data set as stand-ins for "no value" and shouldn't
// override the row's default text.
const NA_RE = /^\s*(na|n\/a)\s*$/i;
const asValue = (v) => {
    if (v == null) return null;
    if (typeof v !== 'string') return v;
    const trimmed = v.trim();
    if (!trimmed || NA_RE.test(trimmed)) return null;
    return trimmed;
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

/**
 * Place the photographs, or the template's stand-in note when there are none.
 *
 * The note is deliberate client-facing copy, so a property without photographs
 * still gets its slide rather than quietly vanishing from the deck.
 */
const layoutPhotos = async (pptx, slide, photos) => {
    if (photos.length === 0) {
        // Framed rather than floated in white space: the note used to sit beside
        // a full table, but on its own slide bare centred text reads as a broken
        // slide. Same panel treatment a failed image download gets.
        slide.addShape('rect', {
            ...PHOTO_REGION,
            fill: { color: 'F7F7F7' }, line: { color: 'D0D0D0', width: 0.5 },
        });
        slide.addText('Photos not available.\nCan be provided upon request.', {
            ...PHOTO_REGION,
            fontFace: FONT, fontSize: 16, color: '808080', align: 'center', valign: 'middle',
        });
        return;
    }
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
 * Carries the same "Option N" title as the details slide it follows, so a reader
 * landing on it knows which property they are looking at.
 */
async function generatePhotosSlideTci(pptx, warehouse, selectedPhotoUrls, optionIndex) {
    const slide = startOptionSlide(pptx, optionIndex, 'Photos');
    const imagePhotos = (selectedPhotoUrls || []).filter(isImageUrl).slice(0, 4);
    await layoutPhotos(pptx, slide, imagePhotos);
}

/**
 * An option's specification table, full width.
 *
 * The table used to share the slide with the photographs, taking the left half;
 * the photographs now have their own slide, so it spans the content box.
 */
async function generateDetailedSlideTci(pptx, warehouse, selectedPhotoUrls, optionIndex) {
    const slide = startOptionSlide(pptx, optionIndex, 'Property Details');

    const projectName = warehouse.projectName
        || warehouse.address
        || [warehouse.city, warehouse.state].filter(Boolean).join(', ')
        || `Property ${warehouse.id}`;

    const wd = warehouse.WarehouseData || {};
    const lat = wd.latitude, lng = wd.longitude;
    const hasCoords = typeof lat === 'number' && typeof lng === 'number';
    const mapsUrl = warehouse.googleLocation
        || (hasCoords ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}` : null);
    const coordsText = hasCoords ? `${lat}, ${lng}` : (warehouse.googleLocation ? 'See link' : 'Available on demand');

    // Offered area is the canonical value — fall back to totalSpaceSqft only
    // when offeredSpaceSqft isn't set.
    const offered = asValue(warehouse.offeredSpaceSqft);
    const area = offered
        ? `Offered area – ${offered} sq. ft.`
        : (Array.isArray(warehouse.totalSpaceSqft) && warehouse.totalSpaceSqft.length
            ? `Offered area – ${warehouse.totalSpaceSqft.join(', ')} sq. ft.`
            : 'N/A');

    // Fire safety: concatenate measures with NOC status. "NA"/"N/A"/blank
    // measures are treated as null so we only show the NOC half when the
    // measures string is a placeholder.
    const fireMeasures = asValue(wd.fireSafetyMeasures);
    const fireNocLabel = wd.fireNocAvailable == null
        ? 'NOC status not available'
        : `NOC ${wd.fireNocAvailable ? 'Available' : 'Not available'}`;
    const fireSafetyValue = [fireMeasures, fireNocLabel].filter(Boolean).join(', ');

    // Power: prefer the numeric KVA field; fall back to "Available" per PM
    // direction since this column isn't reliably backfilled yet.
    const powerKva = asValue(wd.powerKva);
    const electricalValue = powerKva ? `${powerKva} KVA` : 'Available';

    // CLU display follows the v2 convention: blank/Other land types resolve to
    // "Unverified CLU"; anything else shows as "<landType> CLU".
    const landTypeStr = asValue(wd.landType);
    const isUnverifiedCLU = !landTypeStr || /^others?$/i.test(landTypeStr);
    const cluValue = isUnverifiedCLU ? 'Unverified CLU' : `${landTypeStr} CLU`;

    // The `availability` column is a yes/no flag in the DB — translate to a
    // human-readable handover timeline. Anything else (e.g. a future date) is
    // passed through unchanged.
    const availabilityRaw = asValue(warehouse.availability);
    const handoverValue = availabilityRaw && /^yes$/i.test(availabilityRaw)
        ? 'Immediate'
        : (availabilityRaw || 'Available');

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

    const cells = [
        [
            { text: 'Project name', options: headerCellOpts },
            { text: projectName, options: headerCellOpts },
        ],
        [
            { text: 'Building Structural Details', options: { ...subHeaderOpts, colspan: 2 } },
        ],
        ['Type of Option', asValue(warehouse.warehouseType) || 'N/A'],
        ['Google Coordinates', mapsUrl
            ? { text: coordsText, options: { ...valueOpts, hyperlink: { url: mapsUrl }, color: COLORS.hyperlink, underline: { style: 'sng' } } }
            : coordsText],
        ['Status of Land', cluValue],
        ['Area details', area],
        ['Rental per sq. ft.', asValue(warehouse.ratePerSqft) ? `${asValue(warehouse.ratePerSqft)} + GST` : 'On request'],
        ['Eaves Height', (() => {
            const v = asValue(warehouse.clearHeightFt);
            if (!v) return 'N/A';
            // Some rows already carry the unit ("10 ft", "10ft", "10 FT.") — strip
            // any trailing ft/feet token before re-appending so we don't end up
            // with "10 ft ft".
            const stripped = String(v).replace(/\s*(ft|feet)\.?\s*$/i, '').trim();
            return `${stripped} ft`;
        })()],
        ['Type Of Flooring', asValue(warehouse.flooringType) || 'Unverified'],
        ['Floor Load Capacity', asValue(warehouse.floorStrengthPerSqm) || 'Unverified'],
        ['No. of docks', asValue(warehouse.numberOfDocks) ? `${asValue(warehouse.numberOfDocks)} Nos` : 'N/A'],
        // PM-requested fallbacks. The 'Running Canopy' / 'Turbo vent' defaults
        // are temporary stand-ins until the backfill exercise populates these
        // columns — drop them once data lands.
        ['Canopy details', asValue(warehouse.canopyType) || 'Running Canopy'],
        ['Ventilation details', asValue(warehouse.ventilationType) || 'Turbo vent'],
        ['Insulation details', asValue(warehouse.insulationType) || 'Not available'],
        ['Electrical workload', electricalValue],
        ['Toilets', 'Available'],
        ['Building Stability Certificate', 'Available'],
        ['Fire safety details', fireSafetyValue || 'N/A'],
        // `availability` is the closest existing column to the requested
        // handover-timeline field; use it directly until a dedicated column
        // is added.
        ['Handover timeline', handoverValue],
    ].map((row, i) => {
        if (i < 2) return row; // header rows already shaped
        const [label, value] = row;
        const valueCell = (value && typeof value === 'object' && value.options)
            ? value
            : { text: clamp(value ?? 'N/A'), options: valueOpts };
        return [{ text: label, options: labelOpts }, valueCell];
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
