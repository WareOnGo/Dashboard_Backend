// Compare meaning without rewriting stored legacy values. Unit conversions are
// deliberately excluded: changing units remains an explicit proposed value.
const bareUnits = {
  approachRoadWidth: 'feet', clearHeightFt: 'feet', plinthHeightFt: 'feet',
  dockDimension: 'feet', dockApronLengthFt: 'feet', gateSizeFt: 'feet',
  floorStrengthPerSqm: 'tonnes/sq m', lightingDetails: 'lux', powerKva: 'kva',
};
const measured = new Set([...Object.keys(bareUnits), 'distance_from_highway', 'land_parcel_size', 'builtup_area', 'carpet_area', 'dimensions', 'centreHeight']);
const numericText = new Set(['ratePerSqft','numberOfDocks','totalFloors','passengerLiftCount','serviceLiftCount','ventilationAirChangesPerDay','negotiated_rent','cam']);
const decimal = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
const ungroup = text => /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text) ? text.replaceAll(',', '') : text;
function canonical(value, key) {
  if (key === 'media') return ['images', 'videos', 'docs'].map(kind => value?.[kind] || []);
  if (value == null || value === '') return null;
  if (['ccRoads', 'insulationPresent', 'warehouseData.vaastuCompliance'].includes(key)
      && /^(true|false|yes|no)$/i.test(String(value))) return /^(true|yes)$/i.test(String(value));
  if (key === 'availabilityReview' && typeof value === 'object') {
    return [canonical(value.availability, 'availability'), value.availabilityLastReviewedOn?.slice(0, 10) || null];
  }
  if (key === 'handover' && typeof value === 'object') {
    // Old rows had a date before the type column existed. Inactive mode values
    // are retained by the normal form, but are not part of the displayed value.
    return value.handoverType === 'VARIABLE'
      ? ['VARIABLE', value.handoverLeadValue, value.handoverLeadUnit]
      : ['FIXED', value.handoverDate?.slice(0, 10) || null];
  }
  if (key === 'suitableFor' && Array.isArray(value)) return [...value].sort();
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return null;
  if (key === 'contactNumber' || key === 'alt_phone_number') {
    if (!/^(?:\+|00)?[\d\s().-]+$/.test(text)) return text;
    let digits = text.replace(/\D/g, '');
    if (text.startsWith('00')) digits = digits.slice(2);
    if (!/^(?:\+|00)/.test(text) && digits.length === 10) digits = '91' + digits;
    return digits;
  }
  const leaf = key?.split('.').at(-1);
  if (numericText.has(leaf) && decimal.test(ungroup(text))) return Number(ungroup(text));
  if (!measured.has(leaf)) return text;
  const match = text.toLowerCase().match(/^([\d.,]+(?:\s*[x×]\s*[\d.,]+)*)\s*(.*?)$/);
  if (!match) return text;
  const parts = match[1].split(/\s*[x×]\s*/).map(ungroup);
  if (!parts.every(part => decimal.test(part))) return text;
  let unit = match[2].trim().replace(/\s+/g, ' ');
  const aliases = { ft: 'feet', foot: 'feet', m: 'metres', meter: 'metres', meters: 'metres', metre: 'metres', sqft: 'sq ft', 'square feet': 'sq ft', sqm: 'sq m', 'square metres': 'sq m', 'square meters': 'sq m', acre: 'acres', hectare: 'hectares' };
  unit = aliases[unit] || unit || bareUnits[leaf] || '';
  return { parts: parts.map(Number), unit };
}
function equivalent(a, b, key) {
  return JSON.stringify(canonical(a, key)) === JSON.stringify(canonical(b, key));
}
module.exports = { equivalent };
