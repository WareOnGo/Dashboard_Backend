const { parseValue, sameValue, fields, schemas, getValue, patchFor } = require('../../src/fieldReview/fields');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

test.each(['warehouseData.latitude', 'warehouseData.longitude', 'chargeableArea'])(
  '%s never coerces malformed JSON into a valid number', key => {
    for (const value of [false, true, [], [12], {}, '', '  ', '12', Infinity, NaN]) {
      expect(() => parseValue(key, value, {})).toThrow();
    }
    expect(parseValue(key, 12, {})).toBe(12);
    expect(parseValue(key, null, {})).toBeNull();
  },
);

test('handover equality ignores JSON key order and inactive mode values', () => {
  const baseline = { handoverType: 'FIXED', handoverDate: '2026-12-01', handoverLeadValue: null, handoverLeadUnit: null };
  const proposed = { handoverLeadUnit: 'MONTHS', handoverDate: '2026-12-01', handoverType: 'FIXED', handoverLeadValue: 3 };
  expect(sameValue(baseline, proposed, 'handover')).toBe(true);
  expect(sameValue(baseline, { ...proposed, handoverDate: '2026-12-02' }, 'handover')).toBe(false);
});

test('required stored values cannot be staged as null through lenient ingestion schemas', () => {
  expect(() => parseValue('zone', null, {})).toThrow('Zone cannot be cleared');
  expect(() => parseValue('suitableFor', null, {})).toThrow();
  expect(parseValue('suitableFor', [], {})).toEqual([]);
});

test('handover uses the warehouse form contract for cleared and unconfirmed timing', () => {
  expect(parseValue('handover', { handoverType: 'FIXED', handoverDate: null }, {})).toMatchObject({
    handoverType: 'FIXED', handoverDate: null, handoverLeadValue: null, handoverLeadUnit: null,
  });
  expect(parseValue('handover', { handoverType: 'VARIABLE', handoverLeadValue: 2, handoverLeadUnit: null }, {})).toMatchObject({
    handoverType: 'VARIABLE', handoverLeadValue: 2, handoverLeadUnit: null,
  });
  expect(() => parseValue('handover', { handoverType: 'VARIABLE', handoverLeadValue: '2.5' }, {})).toThrow();
});

test('legacy Yes/No toggle values compare equally to the current form encoding', () => {
  for (const key of ['ccRoads', 'insulationPresent', 'warehouseData.vaastuCompliance']) {
    expect(sameValue('Yes', 'true', key)).toBe(true);
    expect(sameValue('No', 'false', key)).toBe(true);
    expect(sameValue(null, 'false', key)).toBe(false);
  }
});

test('all flaggable fields have database change tracking', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../scripts/sql/fieldReview.sql'), 'utf8');
  const tracked = [...sql.matchAll(/EXECUTE FUNCTION field_review_track_edit\('\{([^}]+)\}'\)/g)];
  const keys = [...tracked[0][1].split(','), ...tracked[1][1].split(',').map(key => 'warehouseData.' + key)].sort();
  expect(keys).toEqual(fields.map(field => field.key).sort());
});

test('availability review requires the complete pair and validates its date together', () => {
  const value = { availability: 'No', availabilityLastReviewedOn: '2026-11-16' };
  expect(parseValue('availabilityReview', value)).toEqual(value);
  expect(parseValue('availabilityReview', { availability: 'Yes', availabilityLastReviewedOn: null })).toEqual({ availability: 'Yes', availabilityLastReviewedOn: null });
  expect(parseValue('availabilityReview', { availability: null, availabilityLastReviewedOn: null })).toEqual({ availability: null, availabilityLastReviewedOn: null });
  for (const invalid of [
    'Yes', null, {}, { availability: 'Yes' }, { availabilityLastReviewedOn: null },
    { ...value, availability: null }, { ...value, availability: ' ' },
    { ...value, availabilityLastReviewedOn: '9999-01-01' },
    { ...value, availabilityLastReviewedOn: '2026-02-30' },
    { ...value, availabilityLastReviewedOn: false }, { ...value, ratePerSqft: '99' },
  ]) expect(() => parseValue('availabilityReview', invalid)).toThrow();
});

test('availability is one flaggable item with a complete snapshot and narrow paired patch', () => {
  const pair = { availability: 'Yes', availabilityLastReviewedOn: '2026-11-16' };
  expect(getValue({ ...pair, availabilityLastReviewedOn: new Date('2026-11-16'), ratePerSqft: '22' }, 'availabilityReview')).toEqual(pair);
  expect(patchFor('availabilityReview', pair)).toEqual(pair);
  for (const key of ['availability', 'availabilityLastReviewedOn']) {
    expect(schemas.create.safeParse({ requestId: randomUUID(), warehouseId: 4821, fields: [{ key, comment: 'Check availability.' }] }).success).toBe(false);
    expect(() => parseValue(key, 'Yes')).toThrow('Unknown review field');
  }
  expect(fields.filter(field => field.key === 'availabilityReview')).toHaveLength(1);
});

test('availability comparison includes both values and ignores object key order', () => {
  const value = { availability: 'Yes', availabilityLastReviewedOn: '2026-11-16' };
  expect(sameValue(value, { availabilityLastReviewedOn: '2026-11-16', availability: 'Yes' }, 'availabilityReview')).toBe(true);
  expect(sameValue(value, { ...value, availability: 'No' }, 'availabilityReview')).toBe(false);
  expect(sameValue(value, { ...value, availabilityLastReviewedOn: null }, 'availabilityReview')).toBe(false);
});

test('media proposals require a complete gallery with unique, safe URLs and a total file limit', () => {
  const { emptyMedia } = require('../../src/fieldReview/media');
  const url = 'https://media.example.test/drawing.jpg';
  const media = { ...emptyMedia(), images: [url] };
  expect(parseValue('media', media)).toEqual(media);
  expect(patchFor('media', media)).toEqual({ media, photos: url });
  expect(sameValue(media, { docs: [], images: [url], videos: [] }, 'media')).toBe(true);
  expect(sameValue(media, emptyMedia(), 'media')).toBe(false);
  for (const invalid of [null, { images: [] }, { ...media, extra: [] },
    { ...media, docs: [url] }, { ...media, images: [url, url] },
    { ...media, images: ['javascript:alert(1)'] }, { ...media, images: ['https://user:secret@media.example.test/a.jpg'] },
    { images: Array.from({ length: 150 }, (_, i) => `https://media.example.test/${i}.jpg`),
      videos: [], docs: Array.from({ length: 51 }, (_, i) => `https://media.example.test/${i}.pdf`) },
  ]) expect(() => parseValue('media', invalid)).toThrow();
});
