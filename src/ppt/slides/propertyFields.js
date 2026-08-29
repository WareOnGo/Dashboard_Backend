/**
 * The property field set the TCI deck introduced, in a render-neutral form.
 *
 * Extracted so "the TCI columns" has one definition rather than one per deck:
 * the v3 deck renders the same fields in WareOnGo's own styling, and a fix to
 * how a value is derived — the eaves-height unit stripping, the CLU wording, the
 * fire-safety concatenation — lands in both.
 *
 * Values are plain strings. A row that should link carries `url`, and each deck
 * styles the link itself, since the hyperlink colour is part of its theme rather
 * than part of the data.
 *
 * @typedef {Object} PropertyRow
 * @property {'header'|'subheader'|'field'} kind
 * @property {string} label
 * @property {string} [value]
 * @property {string} [url]  - present when the value should be a hyperlink
 */

// Treat empty strings and the literal placeholders "NA" / "N/A" as null — they
// show up across the data set as stand-ins for "no value" and shouldn't override
// a row's default text.
const NA_RE = /^\s*(na|n\/a)\s*$/i;
const asValue = (v) => {
    if (v == null) return null;
    if (typeof v !== 'string') return v;
    const trimmed = v.trim();
    if (!trimmed || NA_RE.test(trimmed)) return null;
    return trimmed;
};

/**
 * Build the field list for one property.
 *
 * @param {Object} warehouse
 * @param {Object} [flags]
 * @param {boolean} [flags.commercials]  - false withholds the rent
 * @param {boolean} [flags.mapsLocation] - false withholds the coordinates
 * @returns {PropertyRow[]}
 */
function propertyFields(warehouse, flags = {}) {
    const showCommercials = flags.commercials !== false;
    const showMapsLocation = flags.mapsLocation !== false;

    const projectName = warehouse.projectName
        || warehouse.address
        || [warehouse.city, warehouse.state].filter(Boolean).join(', ')
        || `Property ${warehouse.id}`;

    const wd = warehouse.WarehouseData || {};
    const lat = wd.latitude;
    const lng = wd.longitude;
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

    // Some rows already carry the unit ("10 ft", "10ft", "10 FT.") — strip any
    // trailing ft/feet token before re-appending so we don't end up with "10 ft ft".
    const eaves = (() => {
        const v = asValue(warehouse.clearHeightFt);
        if (!v) return 'N/A';
        return `${String(v).replace(/\s*(ft|feet)\.?\s*$/i, '').trim()} ft`;
    })();

    const rental = showCommercials
        ? (asValue(warehouse.ratePerSqft) ? `${asValue(warehouse.ratePerSqft)} + GST` : 'On request')
        : 'Available on Demand';

    const coords = showMapsLocation ? coordsText : 'Available on Demand';

    return [
        { kind: 'header', label: 'Project name', value: projectName },
        { kind: 'subheader', label: 'Building Structural Details' },
        { kind: 'field', label: 'Type of Option', value: asValue(warehouse.warehouseType) || 'N/A' },
        { kind: 'field', label: 'Google Coordinates', value: coords, url: (showMapsLocation && mapsUrl) || undefined },
        { kind: 'field', label: 'Status of Land', value: cluValue },
        { kind: 'field', label: 'Area details', value: area },
        { kind: 'field', label: 'Rental per sq. ft.', value: rental },
        { kind: 'field', label: 'Eaves Height', value: eaves },
        { kind: 'field', label: 'Type Of Flooring', value: asValue(warehouse.flooringType) || 'Unverified' },
        { kind: 'field', label: 'Floor Load Capacity', value: asValue(warehouse.floorStrengthPerSqm) || 'Unverified' },
        { kind: 'field', label: 'No. of docks', value: asValue(warehouse.numberOfDocks) ? `${asValue(warehouse.numberOfDocks)} Nos` : 'N/A' },
        // PM-requested fallbacks. The 'Running Canopy' / 'Turbo vent' defaults
        // are temporary stand-ins until the backfill exercise populates these
        // columns — drop them once data lands.
        { kind: 'field', label: 'Canopy details', value: asValue(warehouse.canopyType) || 'Running Canopy' },
        { kind: 'field', label: 'Ventilation details', value: asValue(warehouse.ventilationType) || 'Turbo vent' },
        { kind: 'field', label: 'Insulation details', value: asValue(warehouse.insulationType) || 'Not available' },
        { kind: 'field', label: 'Electrical workload', value: electricalValue },
        { kind: 'field', label: 'Toilets', value: 'Available' },
        { kind: 'field', label: 'Building Stability Certificate', value: 'Available' },
        { kind: 'field', label: 'Fire safety details', value: fireSafetyValue || 'N/A' },
        // `availability` is the closest existing column to the requested
        // handover-timeline field; use it directly until a dedicated column
        // is added.
        { kind: 'field', label: 'Handover timeline', value: handoverValue },
    ];
}

module.exports = { propertyFields, asValue };
