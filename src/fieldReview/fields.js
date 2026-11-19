const {
  z
} = require('zod');
const WarehouseValidator = require('../validators/warehouseValidator');
const { warehouseMedia, parseMedia, mediaPatch } = require('./media');
const {
  validateReviewAvailability
} = require('../utils/availabilityReview');

// Stable keys also drive the View-mode checkboxes. Generated metadata,
// access/visibility controls and derived micro-markets are intentionally absent.
const groups = {
  'Owner Details': {
    listing_type: 'Listing Type',
    warehouseOwnerType: 'Warehouse Owner Type',
    ownerCompanyName: 'Owner Company Name',
    contactPerson: 'Contact Person',
    contactNumber: 'Contact Number',
    alt_phone_number: 'Alternate Phone Number',
    ownerAltPoc: 'Owner Alternate POC',
    isBroker: 'Is Broker',
    is_builder: 'Is Builder',
    owner_warmnth: 'Owner Warmth',
    owner_of_multiple_sites: 'Owner of Multiple Sites'
  },
  Availability: {
    availabilityReview: 'Availability & last reviewed',
    handover: 'Handover',
    lockInDate: 'Lock-in Date',
    status: 'Status'
  },
  'Location Details': {
    address: 'Address',
    city: 'City',
    state: 'State',
    postalCode: 'Postal Code',
    zone: 'Zone',
    googleLocation: 'Google Location URL',
    'warehouseData.latitude': 'Latitude',
    'warehouseData.longitude': 'Longitude',
    nearest_transport: 'Nearest Bus Transport',
    distance_from_highway: 'Distance from Highway',
    'warehouseData.approachRoadWidth': 'Approach Road Width',
    'warehouseData.landType': 'Land Type',
    'warehouseData.pollutionZone': 'Pollution Zone'
  },
  'Warehouse Technical Specifications': {
    warehouseType: 'Warehouse Type',
    totalFloors: 'Total Number of Floors',
    liftAccess: 'Lift Access',
    passengerLiftCount: 'Number of Passenger Lifts',
    serviceLiftCount: 'Number of Service Lifts',
    liftLoadCapacity: 'Lift Load Capacity',
    totalSpaceSqft: 'Offered Area (sq ft)',
    chargeableArea: 'Chargeable Area (sq ft)',
    land_parcel_size: 'Land Parcel Size',
    builtup_area: 'Built-up Area',
    carpet_area: 'Carpet Area',
    'warehouseData.dimensions': 'Dimensions',
    clearHeightFt: 'Clear Height',
    centreHeight: 'Centre Height',
    plinthHeightFt: 'Plinth Height',
    numberOfDocks: 'Number of Docks',
    dockDimension: 'Dock Dimension',
    dockApronLengthFt: 'Dock Apron Length',
    dockPlatformType: 'Dock Platform Type',
    gateSizeFt: 'Compound Gate Width',
    setbackArea: 'Setback Area',
    ccRoads: 'Paved Roads inside Warehouse?',
    wallAndSecurityRoom: 'Security Features',
    canopyType: 'Canopy Type',
    otherDockingSpecs: 'Other Docking Specs',
    flooringType: 'Flooring Type',
    floorStrengthPerSqm: 'Floor Strength',
    ventilationType: 'Ventilation Type',
    ventilationAirChangesPerDay: 'Ventilation Air Changes/Day',
    insulationPresent: 'Insulation Present',
    insulationType: 'Insulation Type',
    lightingDetails: 'Lighting',
    washroom_count: 'Washroom Count',
    'warehouseData.parkingDockingSpace': 'Parking Space Availability',
    'warehouseData.powerKva': 'Power',
    waterSupply: 'Water Supply',
    suitableFor: 'Suitable For',
    otherSpecifications: 'Other Specifications'
  },
  Compliances: {
    compliances: 'Compliances',
    fire_exits: 'Fire Exits',
    'warehouseData.fireNocAvailable': 'Fire NOC Available',
    'warehouseData.fireSafetyMeasures': 'Fire Safety Measures',
    fire_compliance_cert_type: 'Fire Compliance Certification Type',
    'warehouseData.vaastuCompliance': 'Vaastu Compliance'
  },
  Commercials: {
    ratePerSqft: 'Rate per sq ft',
    negotiated_rent: 'Negotiated Rent',
    cam: 'CAM'
  },
  'Scout Notes': {
    scoutNotes: 'Notes'
  }
};
const enumOptions = {
  waterSupply: ['NONE', 'BOREWELL', 'PIPELINE', 'TANKER', 'OTHERS'],
  status: ['Under construction', 'Build to suit', 'Ready to move'],
  suitableFor: ['PHARMA', 'FMCG', 'FNB', 'RETAIL', 'ECOMMERCE', 'LOGISTICS', 'TRANSSHIPMENT_COURIER', 'FACTORY_INDUSTRIAL', 'KITCHEN', 'DARK_STORE']
};
const booleanKeys = new Set(['is_builder', 'liftAccess', 'warehouseData.fireNocAvailable']);
const numericKeys = new Set(['chargeableArea', 'warehouseData.latitude', 'warehouseData.longitude']);
const dateKeys = new Set(['lockInDate']);
const sensitiveKeys = new Set(['contactNumber', 'alt_phone_number']);
const longKeys = new Set(['address', 'otherDockingSpecs', 'otherSpecifications', 'compliances', 'scoutNotes', 'warehouseData.parkingDockingSpace']);
const fields = Object.entries(groups).flatMap(([section, items]) => Object.entries(items).map(([key, label]) => ({
  key,
  label,
  section,
  sensitive: sensitiveKeys.has(key),
  type: key === 'availabilityReview' ? 'availabilityReview' : key === 'handover' ? 'handover' : booleanKeys.has(key) ? 'boolean' : numericKeys.has(key) ? 'number' : dateKeys.has(key) ? 'date' : key === 'totalSpaceSqft' ? 'integerList' : key === 'suitableFor' ? 'multiSelect' : enumOptions[key] ? 'select' : longKeys.has(key) ? 'textarea' : 'text',
  ...(enumOptions[key] ? {
    options: enumOptions[key]
  } : {}),
  ...(key === 'totalSpaceSqft' ? {
    aliases: ['Offered Area per Floor (sq ft)']
  } : {})
})));
fields.push({ key: 'media', label: 'Media section', section: 'Media', type: 'media', sensitive: false });
const byKey = Object.fromEntries(fields.map(f => [f.key, f]));
const handoverKeys = ['handoverType', 'handoverDate', 'handoverLeadValue', 'handoverLeadUnit'];
const availabilityKeys = ['availability', 'availabilityLastReviewedOn'];
const jsonValue = value => JSON.parse(JSON.stringify(value ?? null));
const dateValue = value => value == null ? null : (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
const getValue = (warehouse, key) => {
  if (key === 'media') return warehouseMedia(warehouse);
  if (key === 'availabilityReview') return {
    availability: jsonValue(warehouse.availability),
    availabilityLastReviewedOn: dateValue(warehouse.availabilityLastReviewedOn)
  };
  if (key === 'handover') return Object.fromEntries(handoverKeys.map(k => [k, k === 'handoverDate' ? dateValue(warehouse[k]) : jsonValue(warehouse[k])]));
  if (dateKeys.has(key)) return dateValue(warehouse[key]);
  const [parent, child] = key.split('.');
  return jsonValue(child ? warehouse.WarehouseData?.[child] : warehouse[parent]);
};
const patchFor = (key, value) => key === 'media' ? mediaPatch(value) : ['handover', 'availabilityReview'].includes(key) ? value : key.startsWith('warehouseData.') ? {
  warehouseData: {
    [key.split('.')[1]]: value
  }
} : {
  [key]: value
};
function parseValue(key, value) {
  if (!Object.hasOwn(byKey, key)) throw new Error('Unknown review field');
  if (key === 'media') return parseMedia(value);
  let parsed;
  if (key === 'availabilityReview') {
    // Require both parts explicitly. A missing date must never inherit evidence
    // for a different availability answer, and approval always writes the pair.
    parsed = WarehouseValidator.createWarehouseSchema.pick({ availability: true, availabilityLastReviewedOn: true }).required().strict().parse(value);
    parsed.availability = parsed.availability?.trim() || null;
    if (parsed.availability?.length > 10000) throw new Error('Value is too long');
    validateReviewAvailability(parsed);
    parsed.availabilityLastReviewedOn = dateValue(parsed.availabilityLastReviewedOn);
  } else if (key === 'handover') {
    const schema = WarehouseValidator.createWarehouseSchema.pick(Object.fromEntries(handoverKeys.map(k => [k, true]))).strict();
    parsed = schema.parse(value);
    // Match the warehouse editor: handover timing can be unconfirmed/cleared,
    // and switching modes preserves the inactive mode's values.
    parsed.handoverType ||= 'FIXED';
    parsed = Object.fromEntries(handoverKeys.map(k => [k, parsed[k] ?? null]));
  } else {
    // The review API receives typed JSON, unlike legacy form ingestion. Reject
    // booleans, arrays and empty strings before the shared schema can coerce them.
    if (numericKeys.has(key)) z.number().finite().nullable().parse(value);
    if (typeof value === 'string') value = value.trim();
    const leaf = key.split('.').at(-1);
    const shape = key.startsWith('warehouseData.') ? WarehouseValidator.warehouseDataSchema.shape : WarehouseValidator.createWarehouseSchema.shape;
    parsed = shape[leaf].parse(value);
    if (parsed === undefined) throw new Error('A proposed value is required');
    if (key === 'zone' && !parsed) throw new Error('Zone cannot be cleared.');
    if (key === 'suitableFor' && parsed === null) throw new Error('Use an empty list to clear Suitable For.');
    if (key === 'totalSpaceSqft' && (!parsed.length || parsed.some(n => n <= 0))) throw new Error('Offered areas must be positive whole numbers');
    if (key === 'warehouseData.latitude' && parsed != null && (parsed < -90 || parsed > 90)) throw new Error('Latitude must be between -90 and 90');
    if (key === 'warehouseData.longitude' && parsed != null && (parsed < -180 || parsed > 180)) throw new Error('Longitude must be between -180 and 180');
    if (key === 'warehouseData.landType' && !parsed) throw new Error('Land Type cannot be cleared.');
    if (key === 'googleLocation' && !parsed) throw new Error('Google Location URL cannot be cleared.');
    if (key === 'chargeableArea' && parsed != null && parsed < 0) throw new Error('Chargeable area cannot be negative');
    if (typeof parsed === 'string' && parsed.length > 10000) throw new Error('Value is too long');
  }
  if (key === 'handover') parsed.handoverDate = dateValue(parsed.handoverDate);
  return dateKeys.has(key) ? dateValue(parsed) : jsonValue(parsed);
}
const sameValue = require('./equivalent').equivalent;
const text = z.string().trim().min(1).max(500);
const version = z.number().int().nonnegative();
const requestId = z.string().uuid();
const schemas = {
  create: z.object({
    requestId,
    warehouseId: z.number().int().positive().max(2147483647),
    assigneeId: z.number().int().positive().max(2147483647).optional(),
    fields: z.array(z.object({
      key: z.enum(Object.keys(byKey)),
      comment: text
    }).strict()).min(1).max(fields.length)
  }).strict(),
  response: z.object({
    requestId,
    version,
    baselineVersion: version,
    resolution: z.enum(['CORRECTION', 'NO_CHANGE']),
    proposedValue: z.unknown().optional(),
    explanation: text
  }).strict(),
  decision: z.object({
    requestId,
    version,
    currentVersion: version,
    choice: z.enum(['PROPOSED', 'CURRENT', 'BASELINE']),
    reason: z.string().trim().max(500).optional(),
    confirmed: z.boolean().optional()
  }).strict(),
  return: z.object({
    requestId,
    version,
    comment: text
  }).strict(),
  reopen: z.object({
    requestId,
    version
  }).strict(),
  cancel: z.object({
    requestId,
    version,
    reason: text
  }).strict(),
  assign: z.object({
    requestId,
    version,
    assigneeId: z.number().int().positive().max(2147483647)
  }).strict(),
  reveal: z.object({
    reason: z.string().trim().min(3).max(500)
  }).strict(),
  upload: WarehouseValidator.fileUploadSchema.strict()
};
module.exports = {
  fields,
  byKey,
  getValue,
  parseValue,
  patchFor,
  jsonValue,
  sameValue,
  handoverKeys,
  availabilityKeys,
  schemas
};
