/**
 * Deterministic warehouses, shaped exactly as `WarehouseModel.findManyForPpt`
 * returns them: flat Warehouse columns plus an included `WarehouseData`.
 *
 * Every value derives from the row index, so a slide rendered today is
 * comparable with one rendered last week. The set deliberately covers the shapes
 * that have broken decks before: one, two, three and four photos; a warehouse
 * with none; a phone photo carrying EXIF rotation; a photo URL that 404s; a
 * multi-value area array; and missing optional fields.
 */

const CITIES = [
  { city: 'Bhiwandi', state: 'Maharashtra', zone: 'WEST', lat: 19.2969, lng: 73.0629 },
  { city: 'Nelamangala', state: 'Karnataka', zone: 'SOUTH', lat: 13.0997, lng: 77.3936 },
  { city: 'Farukhnagar', state: 'Haryana', zone: 'NORTH', lat: 28.4499, lng: 76.8214 },
  { city: 'Oragadam', state: 'Tamil Nadu', zone: 'SOUTH', lat: 12.7409, lng: 79.9584 },
  { city: 'Dankuni', state: 'West Bengal', zone: 'EAST', lat: 22.6797, lng: 88.2853 },
  { city: 'Aslali', state: 'Gujarat', zone: 'WEST', lat: 22.9134, lng: 72.6329 },
];

const TYPES = ['PEB', 'RCC', 'Shed'];

/** Deterministic integer in [min, max] from (index, salt). */
function pick(index, salt, min, max) {
  const h = Math.imul(index + 1, 2654435761) ^ Math.imul(salt + 7, 40503);
  const span = max - min + 1;
  return min + (((h >>> 3) % span) + span) % span;
}

const cycle = (arr, i) => arr[i % arr.length];

/**
 * The photo set for a row, as the comma-separated string the column holds.
 *
 * Index 4 gets no photos at all and index 5 gets one URL that refuses — both are
 * states real rows reach, and both have produced blank or broken slides before.
 * Index 2's first photo carries EXIF Orientation 6, which is what a phone upload
 * looks like; PowerPoint ignores the tag, so the deck builder has to bake the
 * rotation in or the photo lands sideways.
 */
function photosFor(index, imageBase) {
  const label = (n) => `w${1000 + index}-${n}`;
  const jpg = (n, query = '') => `${imageBase}/photo/${label(n)}.jpg${query}`;

  switch (index % 6) {
    case 0: return [jpg(1)];
    case 1: return [jpg(1), jpg(2)];
    case 2: return [jpg(1, '?rotate=6'), jpg(2), jpg(3)];
    case 3: return [jpg(1), jpg(2), jpg(3), `${imageBase}/photo/${label(4)}.png`];
    case 4: return [];
    default: return [jpg(1), jpg(2, '?status=404')];
  }
}

/** One warehouse row. */
function makeWarehouse(index, { imageBase }) {
  const id = 1000 + index;
  const place = cycle(CITIES, index);
  const offered = pick(index, 1, 8, 120) * 1000;
  const photos = photosFor(index, imageBase);

  return {
    id,
    warehouseOwnerType: cycle(['Owner', 'Tenant', '3PL'], index),
    warehouseType: cycle(TYPES, index),
    address: `Plot ${index + 1}, ${place.city} Industrial Estate`,
    // A ?q=lat,lng URL is resolved by geospatialService's regex path without a
    // network call, so coordinate extraction still exercises real code offline.
    googleLocation: `https://maps.google.com/?q=${place.lat},${place.lng}`,
    city: place.city,
    state: place.state,
    postalCode: String(400000 + index * 7),
    zone: place.zone,
    contactPerson: `Contact ${String.fromCharCode(65 + (index % 26))}. Sharma`,
    contactNumber: `98${String(10000000 + index * 137).slice(0, 8)}`,
    // Multi-value on even rows: the area breakdown renders differently for one
    // figure versus several.
    totalSpaceSqft: index % 2 === 0 ? [offered, Math.round(offered * 0.6)] : [offered],
    offeredSpaceSqft: String(offered),
    chargeableArea: Math.round(offered * 1.05),
    numberOfDocks: index % 5 === 0 ? null : String(pick(index, 3, 1, 14)),
    clearHeightFt: String(pick(index, 4, 18, 44)),
    centreHeight: index % 3 === 0 ? String(pick(index, 5, 20, 48)) : null,
    plinthHeightFt: index % 4 === 0 ? '4' : null,
    compliances: index % 2 ? 'Fire NOC, Pollution NOC' : 'Fire NOC',
    otherSpecifications: index % 3 ? 'Temperature-controlled section available' : null,
    ratePerSqft: String(pick(index, 2, 18, 95)),
    availability: cycle(['Y', 'N'], index),
    status: index % 4 === 0 ? 'Under Construction' : 'Ready',
    handoverDate: index % 4 === 0 ? new Date('2026-11-01T00:00:00.000Z') : null,
    lockInDate: null,
    uploadedBy: 'harness@wareongo.com',
    isBroker: index % 3 === 0 ? 'Yes' : 'No',
    visibility: true,
    photos: photos.join(','),
    photosWebp: null,
    media: { images: photos, videos: [], docs: [] },
    flooringType: index % 2 ? 'IPS' : 'Trimix',
    floorStrengthPerSqm: String(pick(index, 6, 3, 12)),
    ventilationType: index % 3 ? 'Turbo ventilators' : null,
    insulationType: index % 5 ? null : 'Rockwool',
    canopyType: index % 4 ? null : 'Cantilever',
    dockDimension: index % 2 ? '10x12' : null,
    projectName: index % 6 === 0 ? `Harness Logistics Park ${index + 1}` : null,
    createdAt: new Date('2026-01-15T00:00:00.000Z'),
    status_updated_at: new Date('2026-06-01T00:00:00.000Z'),

    WarehouseData: {
      latitude: Number((place.lat + index * 0.004).toFixed(6)),
      longitude: Number((place.lng + index * 0.004).toFixed(6)),
      fireNocAvailable: index % 2 === 0,
      fireSafetyMeasures: index % 2 === 0 ? 'Sprinklers, hydrants, extinguishers' : 'Extinguishers',
      landType: cycle(['Industrial', 'Commercial', 'Agricultural'], index),
      approachRoadWidth: String(pick(index, 7, 20, 60)),
      dimensions: `${pick(index, 8, 80, 200)}x${pick(index, 9, 120, 300)}`,
      parkingDockingSpace: `Parking for ${pick(index, 10, 10, 90)} trailers`,
      pollutionZone: index % 3 === 0 ? 'Green' : 'Orange',
      powerKva: String(pick(index, 11, 50, 900)),
      vaastuCompliance: index % 5 === 0,
    },
  };
}

/**
 * @param {object} opts
 * @param {string} opts.imageBase - origin serving fixture photos
 * @param {number} [opts.count]
 * @returns {object[]}
 */
function makeWarehouses({ imageBase, count = 6 } = {}) {
  if (!imageBase) throw new Error('makeWarehouses needs an imageBase');
  return Array.from({ length: count }, (_, i) => makeWarehouse(i, { imageBase }));
}

/**
 * A stand-in for WarehouseModel with only the one method
 * PptGenerationService calls, so the real service can be driven with no
 * database and no container wiring.
 */
function fixtureWarehouseModel(warehouses) {
  return {
    async findManyForPpt(ids) {
      const wanted = new Set(ids.map(Number));
      return warehouses.filter((w) => wanted.has(w.id));
    },
  };
}

/** The customDetails the deck builders read, with every display flag on. */
function defaultCustomDetails(overrides = {}) {
  return {
    clientName: 'Harness Client',
    companyName: 'Harness Logistics Pvt Ltd',
    clientRequirement: '50,000 sq ft in Bhiwandi',
    pocName: 'Harness POC',
    pocContact: '+91 99999 99999',
    commercials: true,
    mapsLocation: true,
    pocSlide: true,
    ...overrides,
  };
}

/** `selectedImages` as the frontend sends it: { [warehouseId]: string[] }. */
function selectedImagesFor(warehouses) {
  const selected = {};
  for (const warehouse of warehouses) {
    if (typeof warehouse.photos === 'string' && warehouse.photos.trim()) {
      selected[warehouse.id] = warehouse.photos.split(',').map((u) => u.trim()).filter(Boolean);
    }
  }
  return selected;
}

module.exports = {
  makeWarehouse,
  makeWarehouses,
  fixtureWarehouseModel,
  defaultCustomDetails,
  selectedImagesFor,
};
