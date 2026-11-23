const request = require('supertest');
const { app, prisma, reset, tokenFor, active } = require('../helpers/app');
const { invalidateCapabilities, resolveCapabilities } = require('../../src/utils/access');
const { pptFormSnapshot } = require('../../src/utils/pptFormPolicy');

const other = { id: 124, uploadedBy: 'colleague@wareongo.com', city: 'Indore',
    availability: 'Yes', availabilityLastReviewedOn: null, handoverType: 'FIXED', handoverDate: null,
    handoverLeadValue: null, handoverLeadUnit: null, contactNumber: '919800000001', WarehouseData: {} };
const update = edits => request(app).put('/api/warehouses/124')
    .set('Authorization', `Bearer ${tokenFor()}`).send(edits);
const grant = overrides => {
    invalidateCapabilities();
    prisma.verifiedNumber.findFirst.mockResolvedValue(active({ editAllWarehouseEntries: false, ...overrides }));
};
beforeEach(() => {
    reset();
    grant();
    prisma.warehouse.findUnique.mockResolvedValue(other);
    prisma.$queryRawUnsafe = jest.fn().mockResolvedValue([]);
    prisma.warehouse.update.mockImplementation(async ({ data }) => ({ ...other, ...data }));
});

test.each([
    { availability: 'No', availabilityLastReviewedOn: '2025-01-10', expectedAvailability: { availability: 'Yes', availabilityLastReviewedOn: null } },
    { availabilityLastReviewedOn: '2025-01-10' },
    { handoverType: 'FIXED', handoverDate: '2027-01-10' },
    { handoverType: 'VARIABLE', handoverLeadValue: 2, handoverLeadUnit: 'MONTHS' },
    { lockInDate: '2027-01-10', status: 'Ready to move' },
])('edit-own permits the Availability section on another uploader: %j', async edits => {
    const { body } = await update({ expectedFormValues: pptFormSnapshot(other), ...edits }).expect(200);
    const data = prisma.warehouse.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ lastEditedBy: 'user@wareongo.com' });
    for (const key of ['city', 'uploadedBy', 'visibility', 'warehouseData', 'contactNumber', 'expectedFormValues']) {
        expect(data).not.toHaveProperty(key);
    }
    expect(body.uploadedBy).toBe(other.uploadedBy);
    expect(body).not.toHaveProperty('contactNumber');
    expect(prisma.auditLog.create).toHaveBeenCalled();
});

test.each([
    { visibility: true }, { city: 'Pune' }, { contactNumber: '123' }, { uploadedBy: 'user@wareongo.com' },
    { warehouseData: { powerKva: '500' } }, { WarehouseData: { powerKva: '500' } },
    { media: { images: [] } }, { photos: '' }, { scoutVoiceNotes: [] }, { wogVerified: true },
    { lastEditedBy: 'someone@wareongo.com' }, { unknownField: 'value' },
])('rejects a mixed payload before any write or schema stripping: %j', async forbidden => {
    await update({ availability: 'No', ...forbidden }).expect(403);
    expect(prisma.warehouse.update).not.toHaveBeenCalled();
});

test.each([
    { editOwnWarehouseEntries: false }, { viewAllWarehouseEntries: false },
    { dashboardAccess: false }, { viewOwnWarehouseEntries: false }, { is_active: false },
])('the exception cannot bypass a revoked grant: %j', async overrides => {
    grant(overrides);
    await update({ availability: 'No' }).expect(403);
    expect(prisma.warehouse.update).not.toHaveBeenCalled();
});

test.each([null, '', 'Legacy uploader'])('missing or legacy attribution does not lock the shared section: %p', async uploadedBy => {
    prisma.warehouse.findUnique.mockResolvedValue({ ...other, uploadedBy });
    await update({ status: 'Ready to move' }).expect(200);
    await update({ visibility: true }).expect(403);
});

test('warm capabilities cannot preserve Availability access after another instance revokes edit-own', async () => {
    await resolveCapabilities('user@wareongo.com');
    prisma.verifiedNumber.findFirst.mockResolvedValue(active({ editOwnWarehouseEntries: false }));
    await update({ availability: 'No' }).expect(403);
    expect(prisma.warehouse.update).not.toHaveBeenCalled();
});

test('stale snapshots and invalid handover values still fail without writing', async () => {
    await update({ availability: 'No', expectedAvailability: { availability: 'Unknown', availabilityLastReviewedOn: null } }).expect(409);
    await update({ expectedFormValues: pptFormSnapshot(other), handoverType: 'VARIABLE', handoverLeadValue: 2 }).expect(400);
    await update({ expectedFormValues: { ...pptFormSnapshot(other), visibility: true }, status: 'Ready to move' }).expect(400);
    expect(prisma.warehouse.update).not.toHaveBeenCalled();
});

test('visit-note writes remain full-edit actions', async () => {
    await request(app).post('/api/warehouses/124/visit-notes')
        .set('Authorization', `Bearer ${tokenFor()}`).send({ note: 'Unauthorized' }).expect(403);
    expect(prisma.warehouseVisitNote.create).not.toHaveBeenCalled();
});

test('service rechecks the stored uploader if ownership changes after the route guard', async () => {
    prisma.warehouse.findUnique.mockResolvedValueOnce({ ...other, uploadedBy: 'user@wareongo.com' }).mockResolvedValue(other);
    await update({ visibility: true }).expect(403);
    expect(prisma.warehouse.update).not.toHaveBeenCalled();
});
