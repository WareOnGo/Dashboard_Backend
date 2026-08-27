const { COLORS, FONT } = require('./themeTci');
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

// Photo column on the right matches the source template's split: table fills
// the left half, two large photos stack vertically on the right.
const PHOTO_REGION = { x: 5.30, y: 1.25, w: 4.45, h: 5.85 };
const GAP = 0.12;

const photoLayouts = {
    1: () => [{ ...PHOTO_REGION }],
    2: () => {
        const h = (PHOTO_REGION.h - GAP) / 2;
        return [
            { x: PHOTO_REGION.x, y: PHOTO_REGION.y, w: PHOTO_REGION.w, h },
            { x: PHOTO_REGION.x, y: PHOTO_REGION.y + h + GAP, w: PHOTO_REGION.w, h },
        ];
    },
    3: () => {
        const topH = (PHOTO_REGION.h - GAP) * 0.55;
        const botH = PHOTO_REGION.h - topH - GAP;
        const botW = (PHOTO_REGION.w - GAP) / 2;
        return [
            { x: PHOTO_REGION.x, y: PHOTO_REGION.y, w: PHOTO_REGION.w, h: topH },
            { x: PHOTO_REGION.x, y: PHOTO_REGION.y + topH + GAP, w: botW, h: botH },
            { x: PHOTO_REGION.x + botW + GAP, y: PHOTO_REGION.y + topH + GAP, w: botW, h: botH },
        ];
    },
    4: () => {
        const w = (PHOTO_REGION.w - GAP) / 2;
        const h = (PHOTO_REGION.h - GAP) / 2;
        return [
            { x: PHOTO_REGION.x, y: PHOTO_REGION.y, w, h },
            { x: PHOTO_REGION.x + w + GAP, y: PHOTO_REGION.y, w, h },
            { x: PHOTO_REGION.x, y: PHOTO_REGION.y + h + GAP, w, h },
            { x: PHOTO_REGION.x + w + GAP, y: PHOTO_REGION.y + h + GAP, w, h },
        ];
    },
};

const layoutPhotos = async (pptx, slide, photos) => {
    if (photos.length === 0) {
        slide.addText('Photos not available.\nCan be provided upon request.', {
            ...PHOTO_REGION,
            fontFace: FONT, fontSize: 16, color: '808080', align: 'center', valign: 'middle',
        });
        return;
    }
    const boxes = photoLayouts[Math.min(photos.length, 4)]();
    await Promise.all(photos.slice(0, 4).map((url, i) => addImageOrPlaceholder(pptx, slide, url, boxes[i])));
};

async function generateDetailedSlideTci(pptx, warehouse, selectedPhotoUrls, optionIndex) {
    const slide = pptx.addSlide();
    slide.background = { color: COLORS.bg };

    slide.addText(`${optionIndex}. Option ${optionIndex} – Property Details & Photos`, {
        x: 0.32, y: 0.38, w: 7.0, h: 0.55,
        fontFace: FONT, fontSize: 22, bold: true, color: COLORS.text,
    });

    addOptionSlideChrome(slide);

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

    slide.addTable(cells, {
        x: 0.20, y: 1.30, w: 4.95,
        colW: [1.85, 3.10],
        rowH: 0.27,
        border: { type: 'solid', pt: 0.5, color: COLORS.border },
    });

    const imagePhotos = (selectedPhotoUrls || []).filter(isImageUrl).slice(0, 4);
    await layoutPhotos(pptx, slide, imagePhotos);
}

module.exports = { generateDetailedSlideTci };
