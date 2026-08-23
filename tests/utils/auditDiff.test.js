const {
  computeChanges,
  changeMetadata,
  summarizeValue,
  maskValue,
} = require('../../src/utils/auditDiff');

describe('auditDiff', () => {
  describe('computeChanges', () => {
    it('reports only fields present in the edit that actually changed', () => {
      const changes = computeChanges(
        { city: 'Pune', state: 'MH', ratePerSqft: '25' },
        { city: 'Mumbai', state: 'MH' },
      );
      expect(changes).toEqual([{ field: 'city', from: 'Pune', to: 'Mumbai' }]);
    });

    it('records a newly set field with a null before value', () => {
      expect(computeChanges({}, { postalCode: '411001' })).toEqual([
        { field: 'postalCode', from: null, to: '411001' },
      ]);
    });

    it('treats null and undefined as the same empty value', () => {
      expect(computeChanges({ offeredSpaceSqft: null }, { offeredSpaceSqft: undefined })).toEqual([]);
    });

    it('compares arrays structurally', () => {
      const changes = computeChanges(
        { totalSpaceSqft: [10000, 20000] },
        { totalSpaceSqft: [10000, 30000] },
      );
      expect(changes).toEqual([
        { field: 'totalSpaceSqft', from: [10000, 20000], to: [10000, 30000] },
      ]);
    });

    it('compares dates by instant, not identity', () => {
      const before = { visitDate: new Date('2026-08-01T00:00:00.000Z') };
      expect(computeChanges(before, { visitDate: new Date('2026-08-01T00:00:00.000Z') })).toEqual([]);
      const changes = computeChanges(before, { visitDate: new Date('2026-08-02T00:00:00.000Z') });
      expect(changes[0]).toEqual({
        field: 'visitDate',
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-02T00:00:00.000Z',
      });
    });

    it('diffs nested fields one level deep with a dotted path', () => {
      const changes = computeChanges(
        { warehouseData: { latitude: 18.5, longitude: 73.8 } },
        { warehouseData: { latitude: 19.0, longitude: 73.8, powerKva: '750' } },
        { nested: ['warehouseData'] },
      );
      expect(changes).toEqual([
        { field: 'warehouseData.latitude', from: 18.5, to: 19.0 },
        { field: 'warehouseData.powerKva', from: null, to: '750' },
      ]);
    });

    it('skips bookkeeping columns that change on every write', () => {
      const changes = computeChanges(
        { city: 'Pune', updatedByEmail: 'a@x.com' },
        { city: 'Pune', updatedBy: 7, updatedByEmail: 'b@x.com', lastModified: new Date() },
      );
      expect(changes).toEqual([]);
    });

    it('honours extra ignored fields', () => {
      const changes = computeChanges({ zone: 'West' }, { zone: 'South' }, { ignore: ['zone'] });
      expect(changes).toEqual([]);
    });

    it('masks phone-like fields instead of recording them verbatim', () => {
      const changes = computeChanges(
        { contactNumber: '9876543210' },
        { contactNumber: '9990001234' },
      );
      expect(changes).toEqual([
        { field: 'contactNumber', from: '••••••3210', to: '••••••1234', masked: true },
      ]);
    });
  });

  describe('summarizeValue', () => {
    it('truncates long strings and notes the original length', () => {
      const summary = summarizeValue('x'.repeat(400));
      expect(summary).toMatch(/^x{300}… \(400 chars\)$/);
    });

    it('summarizes long arrays instead of inlining them', () => {
      const summary = summarizeValue(Array.from({ length: 50 }, (_, i) => `photo-${i}.jpg`));
      expect(summary).toEqual({
        __summary: 'array',
        length: 50,
        sample: ['photo-0.jpg', 'photo-1.jpg', 'photo-2.jpg'],
      });
    });

    it('summarizes oversized objects by their keys', () => {
      const summary = summarizeValue({ blob: 'y'.repeat(2000), other: 1 });
      expect(summary.__summary).toBe('object');
      expect(summary.keys).toEqual(['blob', 'other']);
      expect(summary.bytes).toBeGreaterThan(1000);
    });

    it('passes small values through untouched', () => {
      expect(summarizeValue(42)).toBe(42);
      expect(summarizeValue(false)).toBe(false);
      expect(summarizeValue(null)).toBeNull();
      expect(summarizeValue({ a: 1 })).toEqual({ a: 1 });
    });
  });

  describe('maskValue', () => {
    it('keeps only the last four characters', () => {
      expect(maskValue('9876543210')).toBe('••••••3210');
    });

    it('fully masks short values and nulls out empty ones', () => {
      expect(maskValue('123')).toBe('•••');
      expect(maskValue(null)).toBeNull();
      expect(maskValue('')).toBeNull();
    });
  });

  describe('changeMetadata', () => {
    it('builds the standard UPDATE payload and merges extras', () => {
      const changes = [{ field: 'city', from: 'Pune', to: 'Mumbai' }];
      expect(changeMetadata(changes, { warehouseId: 5 })).toEqual({
        updatedFields: ['city'],
        changeCount: 1,
        changes,
        warehouseId: 5,
      });
    });

    it('handles an empty diff', () => {
      expect(changeMetadata([])).toEqual({ updatedFields: [], changeCount: 0, changes: [] });
    });
  });
});
