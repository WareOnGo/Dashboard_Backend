const { asValue } = require('../ppt/slides/propertyFields');
const { formatHandover } = require('../ppt/utils/handover');

const text = (value) => String(asValue(value) ?? 'NA');
// Free-text fields often already include units. Only append to bare numbers.
const withUnit = (value, unit) => {
    const cleaned = asValue(value);
    return cleaned == null ? 'NA'
        : /^\d[\d,.]*$/.test(String(cleaned)) ? `${cleaned} ${unit}` : String(cleaned);
};

function roadDistance(warehouse, category) {
    const proximity = warehouse.WarehouseProximity?.find((row) => row.category === category && row.status === 'OK');
    const km = proximity?.roadKm;
    return typeof km === 'number' && Number.isFinite(km) && km >= 0 ? `${km} km` : 'NA';
}

function highwayDistance(warehouse) {
    const proximity = warehouse.WarehouseProximity?.find((row) => row.category === 'national_highway' && row.status === 'OK');
    // The highway-entry backfill records actual road distance in this relation.
    // ON_HIGHWAY uses a 0.01 km storage floor; match the existing PPT wording.
    if (proximity?.warnings?.includes('ON_HIGHWAY')) return 'Direct access';
    const computed = roadDistance(warehouse, 'national_highway');
    return computed === 'NA' ? withUnit(warehouse.distance_from_highway, 'km') : computed;
}

function mapsLocation(warehouse) {
    const url = asValue(warehouse.googleLocation);
    if (url && /^https?:\/\//i.test(url)) return { text: url, hyperlink: url };
    const { latitude: lat, longitude: lng } = warehouse.WarehouseData || {};
    if (typeof lat === 'number' && typeof lng === 'number'
        && Number.isFinite(lat) && Number.isFinite(lng)
        && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        return { text: `${lat}, ${lng}`, hyperlink: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}` };
    }
    return text(url);
}

// Row positions and wording follow the supplied Indore workbook, including its
// spacer at row 10 and "Google Coordinated" label. No sample property data is used.
// Ambiguous fields stay NA until their source is confirmed (see README.md).
function lastMileFields(warehouse) {
    const wd = warehouse.WarehouseData || {};
    const handover = warehouse.handoverType || warehouse.handoverDate
        ? formatHandover(warehouse) : text(warehouse.availability);
    // Last Mile uses the dashboard's Offered Area for this template row by request.
    // Multiple entries can be partition options, so retain them rather than summing.
    const areas = Array.isArray(warehouse.totalSpaceSqft)
        ? warehouse.totalSpaceSqft.filter((area) => Number.isFinite(area) && area >= 0) : [];
    const builtUpArea = areas.length
        ? `${areas.map((area) => area.toLocaleString('en-IN')).join(' / ')} sq ft` : 'NA';
    return [
        { label: '', value: text(warehouse.status), kind: 'status', height: 42 },
        { label: 'Property Details', kind: 'section', height: 20 },
        { label: 'Property Address', value: text(warehouse.address), height: 56 },
        { label: 'Photographs', kind: 'photo', height: 150 },
        // Intentionally left for the consultant to fill in the exported workbook.
        { label: 'Developer Name', value: 'NA' },
        { label: 'Location', value: text(warehouse.address), height: 56 },
        { label: 'Distance from Railway', value: roadDistance(warehouse, 'railway_station') },
        { label: 'Distance from Airport', value: roadDistance(warehouse, 'aerodrome') },
        { label: 'Distance From Highway', value: highwayDistance(warehouse) },
        { label: '', value: '' },
        { label: 'Adjacent Occupiers', value: 'NA' },
        { label: 'Building Details', kind: 'section', height: 20 },
        { label: 'Time frame for availability', value: handover },
        { label: 'Total Built up Area', value: builtUpArea, height: 28 },
        { label: 'Total Land Area', value: text(warehouse.land_parcel_size) },
        { label: 'Connected & Sanctioned  Electricity Load', value: withUnit(wd.powerKva, 'KVA'), height: 30 },
        { label: 'Plan Sanction', value: 'NA' },
        { label: 'Water Source & availability', value: warehouse.waterSupply
            ? warehouse.waterSupply.charAt(0) + warehouse.waterSupply.slice(1).toLowerCase() : 'NA', height: 56 },
        { label: 'Land Zoning', value: text(wd.landType) },
        { label: 'Roof Type', value: 'NA', height: 28 },
        { label: 'Floor Type', value: text(warehouse.flooringType) },
        { label: 'Floor Loading (in tonnes/meters square)', value: text(warehouse.floorStrengthPerSqm), height: 30 },
        { label: 'Fire Fighting System/ Sprinklers', value: text(wd.fireSafetyMeasures), height: 42 },
        { label: 'Number of Docks/exits', value: text(warehouse.numberOfDocks) },
        { label: 'Shed Height (Centre)', value: withUnit(warehouse.centreHeight, 'ft') },
        { label: 'Shed Height (Eve/Side)', value: withUnit(warehouse.clearHeightFt, 'ft') },
        { label: 'Ventilation', value: text(warehouse.ventilationType), height: 42 },
        { label: 'Office area', value: 'NA', height: 28 },
        { label: 'Commercial Details', kind: 'section', height: 20 },
        { label: 'Quoted Rent in Rs./sq. ft./month', value: text(warehouse.ratePerSqft), height: 28 },
        // Consultant-authored; do not populate from database specifications/notes.
        { label: 'Comments', value: 'NA', height: 90 },
        { label: 'Google Coordinated', value: mapsLocation(warehouse), height: 42 },
    ];
}

module.exports = { lastMileFields };
