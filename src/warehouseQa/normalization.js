const { Prisma } = require('@prisma/client');
const { policy } = require('./policy');
const Decimal = Prisma.Decimal.clone({ precision: 40 });
const DEC = '[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const full = (pattern, value, flags = '') => new RegExp('^(?:' + pattern + ')$', flags).test(String(value));
const blank = (v) => v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
const boolean = (v) =>
  typeof v === 'boolean'
    ? v
    : typeof v === 'string' && /^(true|yes|false|no)$/i.test(v.trim())
      ? /^(true|yes)$/i.test(v.trim())
      : null;
const scalar = (v) =>
  ['string', 'number'].includes(typeof v) && full(DEC, String(v).trim())
    ? new Decimal(String(v).trim())
    : null;
const contracts = Object.fromEntries(
  policy['NORMALIZATION.V1'].field_unit_contracts.flatMap((c) => c.field_keys.map((k) => [k, c]))
);
const aliases = {
  feet: ['feet', 'foot', 'ft', 'ft.', "'"],
  metres: ['metres', 'meters', 'metre', 'meter', 'mtr', 'mtrs', 'm'],
  'sq ft': ['sq ft', 'sq. ft.', 'sqft', 'sft', 'ft2', 'ft²', 'square feet'],
  'sq m': ['sq m', 'sq. m.', 'sqm', 'smt', 'm2', 'm²', 'square metres', 'square meters'],
  'tonnes/sq m': ['tonnes/sq m', 'tonnes per sqm', 'tonnes/sqm', 'mt/sqm', 't/sqm', 't/m2', 't/m²'],
  kVA: ['kva'],
  HP: ['hp'],
  km: ['km', 'kms', 'kilometres', 'kilometers', 'kilometre', 'kilometer'],
  lux: ['lux', 'lx'],
  tonnes: ['t', 'mt', 'tonne', 'tonnes', 'ton', 'tons'],
  kg: ['kg', 'kgs', 'kilogram', 'kilograms']
};

// Recognize a single number followed by unit-like text without accepting or
// converting that unit. Ranges and multiple measurements do not match.
function quantityWithUnitText(value) {
  if (typeof value !== 'string') return null;
  const match = value
    .trim()
    .match(
      new RegExp('^(' + DEC + ')\\s*[a-z]+(?:\\s+[a-z]+)*(?:\\s*/\\s*[a-z]+(?:\\s+[a-z]+)*[23²³]?)?$', 'i')
    );
  return match ? scalar(match[1]) : null;
}

function measured(value, key) {
  if (!['string', 'number'].includes(typeof value)) return { values: null, unit: null, basis: 'INVALID' };
  let text = String(value).trim(),
    unit = null,
    basis = 'UNKNOWN';
  if (key === 'warehouseData.powerKva' && /^as\s+per\s+requirement$/i.test(text))
    return { values: null, unit: null, basis: 'ON_REQUEST' };
  const contract = contracts[key];
  const allowed =
    key === 'liftLoadCapacity'
      ? ['tonnes', 'kg']
      : [...contract.canonical_storage_units, ...(contract.recognized_legacy_units || [])];
  const tokens = Object.entries(aliases)
    .filter(([u]) => allowed.includes(u))
    .flatMap(([u, list]) => list.map((a) => [a, u]))
    .sort((a, b) => b[0].length - a[0].length);
  for (const [alias, u] of tokens)
    if (text.toLowerCase().endsWith(alias)) {
      const prefix = text.slice(0, -alias.length).trim();
      if (prefix && /^[+\-\d.,\sx×]+$/i.test(prefix)) {
        text = prefix;
        unit = u;
        basis = 'EXPLICIT';
        break;
      }
    }
  if (!unit && key === 'floorStrengthPerSqm') {
    const match = text.match(new RegExp('^(' + DEC + ')\\s*(?:T|MT|tonnes?|tons?)$', 'i'));
    if (match) {
      text = match[1];
      unit = 'tonnes/sq m';
      basis = 'LEGACY_FIELD_CONVENTION';
    }
  }
  const parts = text.split(/\s*[x×]\s*/i);
  if (parts.length !== (contract.parts || 1)) return { values: null, unit, basis: 'INVALID' };
  const values = parts.map((p) =>
    scalar(/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(p) ? p.replaceAll(',', '') : p)
  );
  if (values.some((v) => v === null)) return { values: null, unit, basis: 'UNSUPPORTED_OR_INVALID' };
  if (!unit) {
    unit = contract.bare_default || null;
    basis = unit ? 'FIELD_DEFAULT' : 'UNKNOWN';
  }
  return { values, unit, basis };
}
function normalized(value, key) {
  const { values, unit } = measured(value, key);
  if (!values || !unit) return null;
  if (
    [
      'clearHeightFt',
      'centreHeight',
      'plinthHeightFt',
      'gateSizeFt',
      'dockApronLengthFt',
      'dockDimension',
      'warehouseData.approachRoadWidth'
    ].includes(key)
  )
    return values.map((v) => (unit === 'metres' ? v.div('0.3048') : v));
  if (['builtup_area', 'carpet_area'].includes(key))
    return values.map((v) => (unit === 'sq m' ? v.div('0.09290304') : v));
  if (key === 'distance_from_highway') return [unit === 'metres' ? values[0].div(1000) : values[0]];
  if (key === 'liftLoadCapacity') return [unit === 'kg' ? values[0].div(1000) : values[0]];
  return values;
}

module.exports = { DEC, full, blank, boolean, scalar, contracts, measured, normalized, quantityWithUnitText };
