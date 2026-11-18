const {
  randomBytes,
  randomUUID
} = require('node:crypto');
const {
  PrismaClient, Prisma
} = require('@prisma/client');
const {
  createSchema
} = require('../helpers/fieldReviewDatabase');
const {
  FieldReviewService
} = require('../../src/fieldReview/service');
const {
  schemas,
  fields,
  getValue
} = require('../../src/fieldReview/fields');
const {
  migrate
} = require('../../scripts/migrateFieldReview');
const testDatabaseUrl = require('../helpers/testDatabaseUrl');
const schema = 'behavior_qa_' + randomBytes(8).toString('hex');
const base = testDatabaseUrl(process.env.TEST_DATABASE_URL),
  url = new URL(base);
url.searchParams.set('schema', schema);
const root = new PrismaClient({
  datasources: {
    db: {
      url: base
    }
  }
});
const db = new PrismaClient({
  datasources: {
    db: {
      url: url.toString()
    }
  }
});
const service = new FieldReviewService(db);
const admin = {
    email: 'admin@wareongo.com'
  },
  employee = {
    email: 'employee@wareongo.com'
  },
  other = {
    email: 'other@wareongo.com'
  };
const q = s => '"' + s.replaceAll('"', '""') + '"';
let created = false;
beforeAll(async () => {
  await root.$executeRawUnsafe('CREATE SCHEMA ' + q(schema));
  created = true;
  await createSchema(db);
  const before = await migrate(db);
  expect(before.mode).toBe('dry-run');
  expect(before.tables.every(t => !t.existed)).toBe(true);
  await migrate(db, true);
  await migrate(db, true);
});
afterAll(async () => {
  await db.$disconnect();
  if (created) await root.$executeRawUnsafe('DROP SCHEMA ' + q(schema) + ' CASCADE');
  await root.$disconnect();
});
beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE "WarehouseFieldReviewEvent","WarehouseFieldFlag","WarehouseFieldReview","WarehouseFieldVersion","WarehouseFieldEdit","WarehouseData","Warehouse","VerifiedNumber",audit_logs CASCADE');
  await db.verifiedNumber.createMany({
    data: [{
      id: 1,
      name: 'Admin',
      email: admin.email,
      phone_number: 'test-admin',
      adminAccess: true,
      is_active: true
    }, {
      id: 2,
      name: 'Employee One',
      email: employee.email,
      phone_number: 'test-employee',
      dashboardAccess: true,
      viewOwnWarehouseEntries: true, editOwnWarehouseEntries: true,
      viewAllWarehouseEntries: true, editAllWarehouseEntries: true,
      is_active: true
    }, {
      id: 3,
      name: 'Other Employee',
      email: other.email,
      phone_number: 'test-other',
      dashboardAccess: true,
      viewOwnWarehouseEntries: true, editOwnWarehouseEntries: true,
      viewAllWarehouseEntries: true, editAllWarehouseEntries: true,
      is_active: true
    }]
  });
  await db.warehouse.create({
    data: {
      id: 4821,
      warehouseType: 'PEB',
      address: 'Fixture',
      city: 'Bhiwandi',
      state: 'Maharashtra',
      zone: 'West',
      contactPerson: 'Fixture Owner',
      contactNumber: '+919999999999',
      uploadedBy: 'Employee One',
      totalSpaceSqft: [50000],
      ratePerSqft: '22',
      numberOfDocks: '6',
      compliances: 'Fixture'
    }
  });
});
const create = async (keys = ['totalSpaceSqft']) => service.create({
  requestId: randomUUID(),
  warehouseId: 4821,
  fields: keys.map(key => ({
    key,
    comment: 'Confirm this value.'
  }))
}, admin);
async function submit(review, index = 0, extra = {}) {
  const flag = review.flags[index];
  return service.respond(review.id, flag.id, {
    requestId: randomUUID(),
    version: flag.version,
    baselineVersion: flag.currentVersion,
    resolution: 'CORRECTION',
    proposedValue: flag.fieldKey === 'totalSpaceSqft' ? [48000] : '24',
    explanation: 'Confirmed with the owner.',
    ...extra
  }, employee);
}
const decision = (flag, extra = {}) => ({
  requestId: randomUUID(),
  version: flag.version,
  currentVersion: flag.currentVersion,
  choice: 'PROPOSED',
  ...extra
});
const live = () => db.warehouse.findUnique({
  where: {
    id: 4821
  }
});
describe('PPT form requirements across field-review responses and verification', () => {
  const { completePptForm, requiredPaths } = require('../fixtures/pptForm');
  beforeEach(async () => {
    const { warehouseData, uploadedBy: _uploader, ...data } = require('../../src/validators/warehouseValidator').validateCreateOrThrow(completePptForm());
    await db.warehouse.update({ where: { id: 4821 }, data: { ...data, WarehouseData: { create: warehouseData } } });
  });
  test.each(requiredPaths)('a correction cannot clear %s', async key => {
    const review = await create([key]);
    await expect(submit(review, 0, { proposedValue: null })).rejects.toMatchObject({ code: 'INVALID_FIELD_VALUE' });
    expect((await service.detail(review.id, admin)).flags[0].status).toBe('NEEDS_RESPONSE');
  });
  test('new handover corrections must provide complete selected timing', async () => {
    const review = await create(['handover']);
    await expect(submit(review, 0, { proposedValue: { handoverType: 'VARIABLE', handoverLeadValue: 2 } }))
      .rejects.toMatchObject({ code: 'INVALID_FIELD_VALUE' });
    const response = await submit(review, 0, { proposedValue: { handoverType: 'VARIABLE', handoverLeadValue: 2, handoverLeadUnit: 'WEEKS' } });
    await service.decide(response.id, response.flags[0].id, decision(response.flags[0]), admin);
    expect(await live()).toMatchObject({ handoverType: 'VARIABLE', handoverLeadValue: 2, handoverLeadUnit: 'WEEKS' });
  });
  test.each([
    ['FIXED', { handoverType: 'VARIABLE', handoverLeadValue: 2, handoverLeadUnit: 'WEEKS' }, { handoverDate: '2027-02-28' }],
    ['VARIABLE', { handoverType: 'FIXED', handoverDate: '2027-03-15' }, { handoverLeadValue: 4, handoverLeadUnit: 'MONTHS' }],
  ])('switching from %s preserves inactive timing in the proposal and verified value', async (handoverType, proposedValue, retained) => {
    await db.warehouse.update({ where: { id: 4821 }, data: { handoverType, handoverLeadValue: 4, handoverLeadUnit: 'MONTHS' } });
    const review = await create(['handover']);
    const response = await submit(review, 0, { proposedValue });
    expect(response.flags[0].proposedValue).toMatchObject({ ...proposedValue, ...retained });
    expect((await live()).handoverType).toBe(handoverType);
    const verified = await service.decide(response.id, response.flags[0].id, decision(response.flags[0]), admin);
    expect(verified.flags[0].finalValue).toMatchObject({ ...proposedValue, ...retained });
    expect(getValue(await live(), 'handover')).toMatchObject({ ...proposedValue, ...retained });
  });
  test('verification rechecks a clearing proposal submitted before enforcement', async () => {
    const review = await create(['clearHeightFt']);
    const response = await submit(review, 0, { proposedValue: '31 feet' });
    // Seed a historical clearing proposal directly; new responses must reject it.
    await db.warehouseFieldFlag.update({ where: { id: response.flags[0].id }, data: { proposedValue: Prisma.JsonNull } });
    await expect(service.decide(response.id, response.flags[0].id, decision(response.flags[0]), admin))
      .rejects.toMatchObject({ code: 'INVALID_FIELD_VALUE' });
    expect((await live()).clearHeightFt).toBe('30 feet');
  });
  test('legacy blanks permit No change, but a stale blank baseline cannot replace a newly filled answer', async () => {
    await db.warehouse.update({ where: { id: 4821 }, data: { clearHeightFt: null, plinthHeightFt: null } });
    let review = await create(['clearHeightFt', 'plinthHeightFt']);
    review = await submit(review, 0, { resolution: 'NO_CHANGE' });
    review = await service.decide(review.id, review.flags[0].id, decision(review.flags[0]), admin);
    expect((await live()).clearHeightFt).toBeNull();
    review = await submit(review, 1, { proposedValue: '1 feet' });
    await db.warehouse.update({ where: { id: 4821 }, data: { plinthHeightFt: '2 feet' } });
    review = await service.detail(review.id, admin);
    await expect(service.decide(review.id, review.flags[1].id, decision(review.flags[1], {
      choice: 'BASELINE', reason: 'Testing a stale blank baseline', confirmed: true,
    }), admin)).rejects.toMatchObject({ code: 'INVALID_FIELD_VALUE' });
    expect((await live()).plinthHeightFt).toBe('2 feet');
  });
});
const polygons = [{ id: 'fixture', name: 'Fixture market', geometry: {
  type: 'Polygon', coordinates: [[[72, 18], [74, 18], [74, 20], [72, 20], [72, 18]]],
} }];
test('uploader default, ambiguous identities, eligibility and explicit assignment', async () => {
  expect((await service.setup(4821, admin)).defaultAssigneeId).toBe(2);
  const review = await create();
  expect(review.assigneeId).toBe(2);
  expect(review.flags[0].status).toBe('NEEDS_RESPONSE');
  await db.verifiedNumber.update({
    where: {
      id: 3
    },
    data: {
      name: 'Employee One'
    }
  });
  // An existing review always retains its chosen owner.
  expect((await service.setup(4821, admin)).defaultAssigneeId).toBe(2);
  await db.warehouseFieldFlag.deleteMany();
  await db.warehouseFieldReviewEvent.deleteMany();
  await db.warehouseFieldReview.deleteMany();
  expect((await service.setup(4821, admin)).defaultAssigneeId).toBeNull();
  await expect(create()).rejects.toMatchObject({
    code: 'ASSIGNEE_REQUIRED'
  });
  const explicit = await service.create({
    requestId: randomUUID(),
    warehouseId: 4821,
    assigneeId: 3,
    fields: [{
      key: 'ratePerSqft',
      comment: 'Check asking rent.'
    }]
  }, admin);
  expect(explicit.assigneeId).toBe(3);
});
test('direct response stages typed data; verification applies exactly one field and moves queues', async () => {
  let r = await create(['totalSpaceSqft', 'numberOfDocks']);
  r = await submit(r);
  expect((await live()).totalSpaceSqft).toEqual([50000]);
  expect((await live()).lastEditedBy).toBeNull();
  expect((await service.list(employee)).counts.current).toBe(1);
  r = await service.decide(r.id, r.flags[0].id, decision(r.flags[0]), admin);
  expect((await live()).totalSpaceSqft).toEqual([48000]);
  expect((await live()).lastEditedBy).toBe(admin.email);
  expect(r.closedAt).toBeNull();
  r = await submit(r, 1, {
    resolution: 'NO_CHANGE',
    proposedValue: undefined,
    explanation: 'Inspected all six docks.'
  });
  r = await service.decide(r.id, r.flags[1].id, decision(r.flags[1]), admin);
  expect((await live()).numberOfDocks).toBe('6');
  expect(r.closedAt).not.toBeNull();
  expect(await service.summaries([4821], employee)).toEqual([]);
  expect((await service.list(employee, {
    view: 'previous'
  })).data).toHaveLength(1);
});
test.each([['CURRENT', [52000]], ['PROPOSED', [48000]], ['BASELINE', [50000]]])('conflicting value: %s is explicit and audited', async (choice, expected) => {
  let r = await submit(await create());
  await db.warehouse.update({
    where: {
      id: 4821
    },
    data: {
      totalSpaceSqft: [52000]
    }
  });
  r = await service.detail(r.id, admin);
  const flag = r.flags[0];
  expect(flag).toMatchObject({
    baselineValue: [50000],
    proposedValue: [48000],
    currentValue: [52000],
    conflict: true,
    hasEditHistory: true
  });
  if (choice !== 'CURRENT') await expect(service.decide(r.id, flag.id, decision(flag, {
    choice
  }), admin)).rejects.toMatchObject({
    code: 'CONFIRMATION_REQUIRED'
  });
  r = await service.decide(r.id, flag.id, decision(flag, {
    choice,
    reason: 'Owner verified usable area.',
    confirmed: true
  }), admin);
  expect((await live()).totalSpaceSqft).toEqual(expected);
  expect(r.flags[0]).toMatchObject({
    status: 'VERIFIED',
    decision: choice,
    finalValue: expected
  });
  expect(r.events.find(e => e.action === 'VERIFIED').payload).toMatchObject({
    baselineValue: [50000],
    proposedValue: [48000],
    currentValue: [52000],
    finalValue: expected
  });
  const history = await service.history(r.id, flag.id, admin);
  expect(history.items.length).toBeGreaterThan(0);
});
test('another edit, including change-and-revert, invalidates the displayed current version', async () => {
  let r = await submit(await create());
  await db.warehouse.update({
    where: {
      id: 4821
    },
    data: {
      totalSpaceSqft: [52000]
    }
  });
  r = await service.detail(r.id, admin);
  const stale = decision(r.flags[0], {
    choice: 'BASELINE',
    reason: 'Reconfirmed.',
    confirmed: true
  });
  await db.warehouse.update({
    where: {
      id: 4821
    },
    data: {
      totalSpaceSqft: [53000]
    }
  });
  await db.warehouse.update({
    where: {
      id: 4821
    },
    data: {
      totalSpaceSqft: [52000]
    }
  });
  await expect(service.decide(r.id, r.flags[0].id, stale, admin)).rejects.toMatchObject({
    code: 'CURRENT_CHANGED'
  });
  expect((await live()).totalSpaceSqft).toEqual([52000]);
});
test('no-change also conflicts; unrelated-field changes do not', async () => {
  let r = await submit(await create(), 0, {
    resolution: 'NO_CHANGE',
    proposedValue: undefined
  });
  await db.warehouse.update({
    where: {
      id: 4821
    },
    data: {
      ratePerSqft: '25'
    }
  });
  expect((await service.detail(r.id, admin)).flags[0].conflict).toBe(false);
  await db.warehouse.update({
    where: {
      id: 4821
    },
    data: {
      totalSpaceSqft: [52000]
    }
  });
  r = await service.detail(r.id, admin);
  expect(r.flags[0].conflict).toBe(true);
  await expect(service.decide(r.id, r.flags[0].id, decision(r.flags[0]), admin)).rejects.toMatchObject({
    code: 'CONFIRMATION_REQUIRED'
  });
});
test('two admins deciding concurrently cannot both win', async () => {
  const r = await submit(await create()),
    flag = r.flags[0];
  const results = await Promise.allSettled([service.decide(r.id, flag.id, decision(flag), admin), service.decide(r.id, flag.id, decision(flag), admin)]);
  expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
  expect(await db.warehouseFieldReviewEvent.count({
    where: {
      action: 'VERIFIED'
    }
  })).toBe(1);
});
test('audit failure rolls back warehouse update, version increment and closure', async () => {
  const r = await submit(await create()),
    flag = r.flags[0];
  await db.$executeRawUnsafe('ALTER TABLE "WarehouseFieldReviewEvent" ADD CONSTRAINT test_fail_decision CHECK (action <> \'VERIFIED\')');
  try {
    await expect(service.decide(r.id, flag.id, decision(flag), admin)).rejects.toBeTruthy();
  } finally {
    await db.$executeRawUnsafe('ALTER TABLE "WarehouseFieldReviewEvent" DROP CONSTRAINT test_fail_decision');
  }
  expect((await live()).totalSpaceSqft).toEqual([50000]);
  const fresh = await service.detail(r.id, admin);
  expect(fresh.flags[0]).toMatchObject({
    status: 'AWAITING_ADMIN',
    currentVersion: flag.currentVersion
  });
});
test('idempotent create/submit retries do not duplicate flags or response events', async () => {
  const body = {
    requestId: randomUUID(),
    warehouseId: 4821,
    fields: [{
      key: 'ratePerSqft',
      comment: 'Confirm rent.'
    }]
  };
  const r = await service.create(body, admin);
  expect((await service.create(body, admin)).id).toBe(r.id);
  const flag = r.flags[0],
    response = {
      requestId: randomUUID(),
      version: flag.version,
      baselineVersion: flag.currentVersion,
      resolution: 'CORRECTION',
      proposedValue: '24',
      explanation: 'Confirmed.'
    };
  await service.respond(r.id, flag.id, response, employee);
  await service.respond(r.id, flag.id, response, employee);
  expect(await db.warehouseFieldReviewEvent.count({
    where: {
      action: 'SUBMITTED'
    }
  })).toBe(1);
  await expect(service.create({
    ...body,
    fields: [{
      key: 'numberOfDocks',
      comment: 'Different.'
    }]
  }, admin)).rejects.toMatchObject({
    code: 'REQUEST_REUSED'
  });
});
test('return, reassignment, fresh authorization and reopen preserve original authors', async () => {
  let r = await submit(await create());
  r = await service.returnForChanges(r.id, r.flags[0].id, {
    requestId: randomUUID(),
    version: r.flags[0].version,
    comment: 'Reconfirm the usable area.'
  }, admin);
  expect(r.flags[0].status).toBe('CHANGES_REQUESTED');
  r = await service.reassign(r.id, {
    requestId: randomUUID(),
    version: r.version,
    assigneeId: 3
  }, admin);
  expect(r.flags[0].respondedBy).toBe(employee.email);
  await expect(service.detail(r.id, employee)).rejects.toMatchObject({
    status: 403
  });
  const f = r.flags[0];
  r = await service.respond(r.id, f.id, {
    requestId: randomUUID(),
    version: f.version,
    baselineVersion: f.currentVersion,
    resolution: 'NO_CHANGE',
    explanation: 'The existing value is confirmed.'
  }, other);
  r = await service.decide(r.id, f.id, decision(r.flags[0]), admin);
  await expect(service.reopen(r.id, f.id, {
    requestId: randomUUID(),
    version: r.flags[0].version
  }, other)).rejects.toMatchObject({
    status: 403
  });
  r = await service.reopen(r.id, f.id, {
    requestId: randomUUID(),
    version: r.flags[0].version
  }, admin);
  expect(r).toMatchObject({
    assigneeId: 3,
    closedAt: null
  });
  expect(r.flags[0].status).toBe('NEEDS_RESPONSE');
  await db.verifiedNumber.update({
    where: {
      id: 3
    },
    data: {
      is_active: false
    }
  });
  await expect(service.detail(r.id, other)).rejects.toMatchObject({
    status: 403
  });
});
test('protected phone snapshots/history require an audited reveal and cannot leak through events', async () => {
  let r = await create(['contactNumber']);
  expect(JSON.stringify(r)).not.toContain('+919999999999');
  r = await service.respond(r.id, r.flags[0].id, {
    requestId: randomUUID(),
    version: 0,
    baselineVersion: 0,
    resolution: 'CORRECTION',
    proposedValue: '+918888888888',
    explanation: 'Corrected owner contact.'
  }, employee);
  expect(JSON.stringify(r)).not.toContain('+918888888888');
  expect(JSON.stringify(r.events)).not.toContain('+919999999999');
  await expect(service.reveal(r.id, r.flags[0].id, {
    reason: 'Client enquiry'
  }, other)).rejects.toMatchObject({
    status: 403
  });
  const revealed = await service.reveal(r.id, r.flags[0].id, {
    reason: 'Verify owner contact for the review'
  }, admin);
  expect(revealed).toMatchObject({
    baselineValue: '+919999999999',
    proposedValue: '+918888888888'
  });
  expect(await db.warehouseFieldReviewEvent.count({
    where: {
      action: 'REVEALED'
    }
  })).toBe(1);
});
test('nested field revisions and dates use the same conflict contract', async () => {
  let r = await create(['warehouseData.powerKva']);
  r = await submit(r, 0, {
    proposedValue: '120'
  });
  r = await service.decide(r.id, r.flags[0].id, decision(r.flags[0]), admin);
  expect((await db.warehouseData.findUnique({
    where: {
      warehouseId: 4821
    }
  })).powerKva).toBe('120');
  expect((await service.detail(r.id, admin)).flags[0].currentVersion).toBeGreaterThan(0);
});
test('unknown/system/media fields and empty no-change reasons are rejected by request validation', () => {
  for (const key of ['id', 'uploadedBy', 'media', 'visibility', 'scoutVoiceNotes', '__proto__']) expect(schemas.create.safeParse({
    requestId: randomUUID(),
    warehouseId: 4821,
    fields: [{
      key,
      comment: 'Check.'
    }]
  }).success).toBe(false);
  expect(schemas.response.safeParse({
    requestId: randomUUID(),
    version: 0,
    baselineVersion: 0,
    resolution: 'NO_CHANGE',
    explanation: ' '
  }).success).toBe(false);
  expect(fields.length).toBeGreaterThan(60);
});
test('employee cannot submit against a baseline changed while drafting', async () => {
  const r = await create();
  await db.warehouse.update({
    where: {
      id: 4821
    },
    data: {
      totalSpaceSqft: [52000]
    }
  });
  await expect(submit(r)).rejects.toMatchObject({
    code: 'BASELINE_CHANGED'
  });
  expect((await service.detail(r.id, employee)).flags[0].status).toBe('NEEDS_RESPONSE');
  expect((await live()).totalSpaceSqft).toEqual([52000]);
});
test('ordinary warehouse edits record the actor and invalidate pending comparisons', async () => {
  const WarehouseModel = require('../../src/models/warehouseModel');
  const r = await submit(await create());
  await new WarehouseModel(db).update(4821, {
    totalSpaceSqft: [52000]
  }, undefined, {
    actorEmail: 'editor@wareongo.com'
  });
  const detail = await service.detail(r.id, admin);
  expect(detail.flags[0].conflict).toBe(true);
  const history = await service.history(r.id, r.flags[0].id, admin);
  expect(history.items[0]).toMatchObject({
    actorEmail: 'editor@wareongo.com',
    oldValue: [50000],
    newValue: [52000],
    source: 'Warehouse edit'
  });
});
test('deleted warehouses retain searchable review history and reject writes', async () => {
  const r = await create();
  await db.warehouse.delete({
    where: {
      id: 4821
    }
  });
  expect(await service.detail(r.id, employee)).toMatchObject({
    deleted: true,
    warehouse: null
  });
  expect((await service.list(employee, {
    search: '4821'
  })).data).toHaveLength(1);
  expect((await service.list(employee, { search: '4821, 9999' })).data).toHaveLength(1);
  expect((await service.list(employee, { search: '4821', city: 'Bhiwandi' })).data).toHaveLength(0);
  await expect(submit(r)).rejects.toMatchObject({
    code: 'WAREHOUSE_NOT_FOUND'
  });
  expect(await db.warehouse.count()).toBe(0);
});
test('same request ID cannot be replayed on another flag with identical response data', async () => {
  const r = await create(['ratePerSqft', 'numberOfDocks']);
  const body = {
    requestId: randomUUID(),
    version: 0,
    baselineVersion: 0,
    resolution: 'NO_CHANGE',
    explanation: 'Confirmed.'
  };
  await service.respond(r.id, r.flags[0].id, body, employee);
  await expect(service.respond(r.id, r.flags[1].id, body, employee)).rejects.toMatchObject({
    code: 'REQUEST_REUSED'
  });
  expect((await service.detail(r.id, employee)).flags[1].status).toBe('NEEDS_RESPONSE');
});
test('nested corrections record the admin while no-change verification preserves the previous editor', async () => {
  let r = await create(['warehouseData.powerKva']);
  r = await submit(r, 0, { proposedValue: '750' });
  await service.decide(r.id, r.flags[0].id, decision(r.flags[0]), admin);
  expect((await live()).lastEditedBy).toBe(admin.email);
  expect((await db.warehouseData.findUnique({ where: { warehouseId: 4821 } })).powerKva).toBe('750');

  await db.warehouse.update({ where: { id: 4821 }, data: { lastEditedBy: 'previous@example.test' } });
  r = await create(['warehouseData.powerKva']);
  r = await submit(r, 0, { resolution: 'NO_CHANGE', proposedValue: undefined, explanation: 'Verified the existing supply.' });
  await service.decide(r.id, r.flags[0].id, decision(r.flags[0]), admin);
  expect((await live()).lastEditedBy).toBe('previous@example.test');
});

test('coordinates refresh derived micro-markets; a Maps URL correction changes only the URL', async () => {
  await db.warehouseData.create({
    data: {
      warehouseId: 4821,
      latitude: 19,
      longitude: 73
    }
  });
  const tagging = {
      getPolygons: jest.fn().mockResolvedValue(polygons)
    },
    geo = new FieldReviewService(db, tagging);
  let r = await create(['warehouseData.latitude']);
  r = await submit(r, 0, {
    proposedValue: 19.5
  });
  await geo.decide(r.id, r.flags[0].id, decision(r.flags[0]), admin);
  expect(tagging.getPolygons).toHaveBeenCalledTimes(1);
  expect((await live()).micromarket).toEqual(['Fixture market']);
  expect((await live()).lastEditedBy).toBe(admin.email);
  r = await create(['googleLocation']);
  r = await submit(r, 0, {
    proposedValue: 'https://www.google.com/maps?q=20,74'
  });
  await geo.decide(r.id, r.flags[0].id, decision(r.flags[0]), admin);
  expect((await db.warehouseData.findUnique({
    where: {
      warehouseId: 4821
    }
  })).latitude).toBe(19.5);
  expect((await live()).googleLocation).toBe('https://www.google.com/maps?q=20,74');
  expect((await service.detail(r.id, admin)).flags[0].status).toBe('VERIFIED');
});
test('an ambiguous inactive identity cannot be offered as a new assignee', async () => {
  await db.verifiedNumber.create({
    data: {
      id: 8,
      name: 'Old account',
      email: 'EMPLOYEE@wareongo.com',
      phone_number: 'test-old',
      is_active: false
    }
  });
  const setup = await service.setup(4821, admin);
  expect(setup.defaultAssigneeId).toBeNull();
  expect(setup.assignees.some(p => p.id === 2)).toBe(false);
  await expect(create()).rejects.toMatchObject({
    code: 'ASSIGNEE_REQUIRED'
  });
});

test('formatting alone requires no-change; equal current choices avoid a redundant edit', async()=>{
 let r=await create(['ratePerSqft']);
 await expect(submit(r,0,{proposedValue:'22.00'})).rejects.toMatchObject({code:'NO_CHANGE_REQUIRED'});
 r=await submit(r,0,{proposedValue:'24.0'});
 await db.warehouse.update({where:{id:4821},data:{ratePerSqft:'24'}});
 r=await service.detail(r.id,admin);
 const version=r.flags[0].currentVersion;
 r=await service.decide(r.id,r.flags[0].id,decision(r.flags[0]),admin);
 expect(r.flags[0]).toMatchObject({status:'VERIFIED',decision:'PROPOSED',currentVersion:version,finalValue:'24'});
 expect((await live()).ratePerSqft).toBe('24');
});

test('an inactive namesake never causes assignment to the wrong uploader', async()=>{
 await db.verifiedNumber.create({data:{id:9,name:'Employee One',email:'former@wareongo.com',phone_number:'test-former',is_active:false}});
 expect((await service.setup(4821,admin)).defaultAssigneeId).toBeNull();
 await expect(create()).rejects.toMatchObject({code:'ASSIGNEE_REQUIRED'});
 await db.warehouse.update({where:{id:4821},data:{uploadedBy:'former@wareongo.com'}});
 const r=await service.create({requestId:randomUUID(),warehouseId:4821,assigneeId:2,fields:[{key:'ratePerSqft',comment:'Confirm rent.'}]},admin);
 expect(r).toMatchObject({uploaderId:9,assigneeId:2});
});

test('new field edits do not hide older available audit history', async () => {
  const r = await create(['ratePerSqft']);
  await db.auditLog.create({ data: {
    entity: 'warehouse', entityId: '4821', action: 'UPDATE', userEmail: admin.email,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    metadata: { changes: [{ field: 'ratePerSqft', from: '20', to: '22' }] },
  } });
  await db.warehouse.update({ where: { id: 4821 }, data: { ratePerSqft: '25' } });
  const result = await service.history(r.id, r.flags[0].id, admin);
  expect(result.items.map(item => [item.oldValue, item.newValue])).toEqual([['22', '25'], ['20', '22']]);
});

test('server supplies meaningful replacement comparisons for formatted-equal values', async () => {
  let r = await submit(await create(['ratePerSqft']), 0, { proposedValue: '24.0' });
  await db.warehouse.update({ where: { id: 4821 }, data: { ratePerSqft: '24' } });
  r = await service.detail(r.id, admin);
  expect(r.flags[0]).toMatchObject({
    conflict: true, replacementRequired: { CURRENT: false, PROPOSED: false, BASELINE: true },
  });
});

test('review snapshots cannot be read directly by an unprivileged database role', async () => {
  await create(['contactNumber']);
  const role = 'field_review_reader_' + randomBytes(6).toString('hex');
  await root.$executeRawUnsafe('CREATE ROLE ' + q(role) + ' NOLOGIN');
  try {
    await db.$executeRawUnsafe('GRANT USAGE ON SCHEMA ' + q(schema) + ' TO ' + q(role));
    await db.$executeRawUnsafe('GRANT SELECT ON "WarehouseFieldFlag" TO ' + q(role));
    const rows = await db.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE ' + q(role));
      return tx.$queryRawUnsafe('SELECT "originalValue" FROM "WarehouseFieldFlag"');
    });
    expect(rows).toEqual([]);
  } finally {
    await root.$executeRawUnsafe('DROP OWNED BY ' + q(role));
    await root.$executeRawUnsafe('DROP ROLE ' + q(role));
  }
});

test('comments added to an existing cycle retain the admin who actually flagged them', async () => {
  const first = await create(['ratePerSqft']);
  await db.verifiedNumber.update({ where: { id: 3 }, data: { adminAccess: true } });
  const r = await service.create({ requestId: randomUUID(), warehouseId: 4821,
    fields: [{ key: 'numberOfDocks', comment: 'Please check the dock count.' }],
  }, other);
  expect(r.id).toBe(first.id);
  expect(r.flags.find(flag => flag.fieldKey === 'ratePerSqft').createdBy).toBe(admin.email);
  expect(r.flags.find(flag => flag.fieldKey === 'numberOfDocks').createdBy).toBe(other.email);
});

test('slow location preparation holds no warehouse lock and uses the latest coordinate pair', async () => {
  await db.warehouseData.create({ data: { warehouseId: 4821, latitude: 19, longitude: 73 } });
  const r = await submit(await create(['warehouseData.latitude']), 0, { proposedValue: 19.5 });
  let ready, finish;
  const preparing = new Promise(resolve => { ready = resolve; });
  const geo = new FieldReviewService(db, { getPolygons: () => {
    ready();
    return new Promise(resolve => { finish = resolve; });
  } });
  const approval = geo.decide(r.id, r.flags[0].id, decision(r.flags[0]), admin);
  try {
    await preparing;
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout='300ms'");
      await tx.warehouseData.update({ where: { warehouseId: 4821 }, data: { longitude: 75 } });
    });
  } finally {
    finish(polygons);
    await approval;
  }
  expect((await live()).micromarket).toEqual([]); // 19.5,75 is outside the polygon.
  expect(await db.warehouseData.findUnique({ where: { warehouseId: 4821 } })).toMatchObject({ latitude: 19.5, longitude: 75 });
});

test('large numeric search terms are text searches, not overflowing warehouse IDs', async () => {
  await create();
  expect((await service.list(admin, { search: '999999999999' })).data).toEqual([]);
});

test('edit history retains write order even when timestamps tie', async () => {
  const r = await create(['ratePerSqft']);
  await db.$transaction(async tx => {
    await tx.warehouse.update({ where: { id: 4821 }, data: { ratePerSqft: '23' } });
    await tx.warehouse.update({ where: { id: 4821 }, data: { ratePerSqft: '24' } });
  });
  await db.warehouseFieldEdit.updateMany({ data: { createdAt: new Date('2026-11-16T12:00:00Z') } });
  const history = await service.history(r.id, r.flags[0].id, admin);
  expect(history.items.map(item => [item.version, item.oldValue, item.newValue])).toEqual([[2, '23', '24'], [1, '22', '23']]);
});

test('legacy handover history exposes the recorded parts without inventing a full snapshot', async () => {
  const r = await create(['handover']);
  await db.auditLog.create({ data: {
    entity: 'warehouse', entityId: '4821', action: 'UPDATE', userEmail: admin.email,
    metadata: { changes: [
      { field: 'handoverDate', from: '2026-12-01', to: '2026-12-02' },
      { field: 'handoverLeadValue', from: 2, to: 3 },
    ] },
  } });
  const history = await service.history(r.id, r.flags[0].id, admin);
  expect(history.items).toMatchObject([
    { partLabel: 'Handover date', oldValue: '2026-12-01', newValue: '2026-12-02' },
    { partLabel: 'Lead time', oldValue: 2, newValue: 3 },
  ]);
  expect(new Set(history.items.map(item => item.id)).size).toBe(2);
});

test('a handover correction cannot clear a previously confirmed date', async () => {
  await db.warehouse.update({ where: { id: 4821 }, data: {
    handoverType: 'FIXED', handoverDate: new Date('2026-12-01'), handoverLeadValue: 2, handoverLeadUnit: 'WEEKS',
  } });
  const review = await create(['handover']);
  await expect(submit(review, 0, { proposedValue: {
    handoverType: 'FIXED', handoverDate: null, handoverLeadValue: 2, handoverLeadUnit: 'WEEKS',
  } })).rejects.toMatchObject({ code: 'INVALID_FIELD_VALUE' });
  expect(await live()).toMatchObject({ handoverDate: new Date('2026-12-01'), handoverLeadValue: 2, handoverLeadUnit: 'WEEKS' });
});

test.each(['FIXED', 'VARIABLE'].flatMap(mode => ['PROPOSED', 'BASELINE'].map(choice => [mode, choice])))
('handover %s %s preserves newer timing saved for the other mode', async (mode, choice) => {
  const baseline = { handoverType: mode, handoverDate: '2026-12-01', handoverLeadValue: 2, handoverLeadUnit: 'WEEKS' };
  const proposed = mode === 'FIXED' ? { ...baseline, handoverDate: '2026-12-02' } : { ...baseline, handoverLeadValue: 3 };
  const current = { ...baseline, handoverDate: '2026-12-10', handoverLeadValue: 6, handoverLeadUnit: 'MONTHS' };
  await db.warehouse.update({ where: { id: 4821 }, data: { ...baseline, handoverDate: new Date(baseline.handoverDate) } });
  const r = await submit(await create(['handover']), 0, { proposedValue: proposed });
  // An ordinary edit changes both the visible timing and the saved other type.
  await db.warehouse.update({ where: { id: 4821 }, data: { ...current, handoverDate: new Date(current.handoverDate) } });
  const fresh = await service.detail(r.id, admin), flag = fresh.flags[0];
  expect(flag.conflict).toBe(true);
  const selected = choice === 'PROPOSED' ? proposed : baseline;
  const expected = mode === 'FIXED'
    ? { ...selected, handoverLeadValue: current.handoverLeadValue, handoverLeadUnit: current.handoverLeadUnit }
    : { ...selected, handoverDate: current.handoverDate };
  const done = await service.decide(r.id, flag.id, decision(flag, { choice, confirmed: true, reason: 'Verified the selected timing with the owner.' }), admin);
  expect(getValue(await live(), 'handover')).toEqual(expected);
  expect(done.flags[0].finalValue).toEqual(expected);
  expect(done.events.find(e => e.action === 'VERIFIED').payload.finalValue).toEqual(expected);
});

describe('linked availability review', () => {
  const baseline = { availability: 'Yes', availabilityLastReviewedOn: '2026-11-10' };
  const proposal = { availability: 'Yes', availabilityLastReviewedOn: '2026-11-16' };
  const pair = row => getValue(row, 'availabilityReview');
  const seedPair = async (value = baseline) => db.warehouse.update({ where: { id: 4821 }, data: {
    ...value, availabilityLastReviewedOn: value.availabilityLastReviewedOn ? new Date(value.availabilityLastReviewedOn) : null,
  } });
  const normalEdit = async data => {
    const { prepareAvailabilityUpdate } = require('../../src/utils/availabilityReview');
    const WarehouseModel = require('../../src/models/warehouseModel');
    const existing = await live();
    const guard = prepareAvailabilityUpdate(existing, data, pair(existing));
    return new WarehouseModel(db).update(4821, data, guard, { actorEmail: 'editor@wareongo.com' });
  };
  const changes = [
    ['availability', { availability: 'No' }, { availability: 'No', availabilityLastReviewedOn: null }],
    ['last reviewed', { availabilityLastReviewedOn: new Date('2026-11-12') }, { availability: 'Yes', availabilityLastReviewedOn: '2026-11-12' }],
  ];

  test('reproduced date-only response detects a later normal availability edit and records the complete pair', async () => {
    await seedPair({ availability: 'Yes', availabilityLastReviewedOn: null });
    const r = await submit(await create(['availabilityReview']), 0, { proposedValue: proposal });
    const submitted = r.flags[0];
    expect(pair(await live())).toEqual({ availability: 'Yes', availabilityLastReviewedOn: null });
    await normalEdit({ availability: 'No' });
    const fresh = await service.detail(r.id, admin), flag = fresh.flags[0];
    expect(flag).toMatchObject({ conflict: true, currentVersion: submitted.currentVersion + 1,
      baselineValue: { availability: 'Yes', availabilityLastReviewedOn: null }, proposedValue: proposal,
      currentValue: { availability: 'No', availabilityLastReviewedOn: null },
    });
    await expect(service.decide(r.id, flag.id, decision(submitted), admin)).rejects.toMatchObject({ code: 'CURRENT_CHANGED' });
    await expect(service.decide(r.id, flag.id, decision(flag), admin)).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    const history = await service.history(r.id, flag.id, admin);
    expect(history.items[0]).toMatchObject({ fieldKey: 'availabilityReview', actorEmail: 'editor@wareongo.com',
      oldValue: { availability: 'Yes', availabilityLastReviewedOn: null }, newValue: { availability: 'No', availabilityLastReviewedOn: null },
    });
    expect(pair(await live())).toEqual({ availability: 'No', availabilityLastReviewedOn: null });
    expect(flag.status).toBe('AWAITING_ADMIN');
  });

  test.each(changes.flatMap(([part, edit, current]) => ['CURRENT', 'PROPOSED', 'BASELINE'].map(choice => [part, choice, edit, current])))(
    '%s changed in transit: %s chooses and audits the complete pair', async (_part, choice, edit, current) => {
      await seedPair();
      let r = await submit(await create(['availabilityReview']), 0, { proposedValue: proposal });
      await normalEdit({ ...edit });
      r = await service.detail(r.id, admin);
      const flag = r.flags[0];
      expect(flag.conflict).toBe(true);
      const final = choice === 'CURRENT' ? current : choice === 'BASELINE' ? baseline : proposal;
      const done = await service.decide(r.id, flag.id, decision(flag, { choice,
        ...(choice !== 'CURRENT' ? { reason: 'Checked both the answer and its review date.', confirmed: true } : {}),
      }), admin);
      expect(pair(await live())).toEqual(final);
      expect((await live()).ratePerSqft).toBe('22');
      expect(done.flags[0]).toMatchObject({ status: 'VERIFIED', finalValue: final,
        currentVersion: flag.currentVersion + (choice === 'CURRENT' ? 0 : 1),
      });
      const event = await db.warehouseFieldReviewEvent.findFirst({ where: { flagId: flag.id, action: 'VERIFIED' } });
      expect(event.payload).toMatchObject({ baselineValue: baseline, proposedValue: proposal, currentValue: current, finalValue: final, choice });
    },
  );

  test.each(changes)('a draft becomes stale when %s changes, including no-change responses', async (_part, edit) => {
    await seedPair();
    const r = await create(['availabilityReview']);
    await normalEdit({ ...edit });
    for (const resolution of ['CORRECTION', 'NO_CHANGE']) {
      await expect(submit(r, 0, { proposedValue: proposal, resolution })).rejects.toMatchObject({ code: 'BASELINE_CHANGED' });
    }
    expect((await service.detail(r.id, employee)).flags[0].status).toBe('NEEDS_RESPONSE');
  });

  test.each(changes)('a pending no-change response conflicts when %s changes', async (_part, edit) => {
    await seedPair();
    const r = await submit(await create(['availabilityReview']), 0, { resolution: 'NO_CHANGE', proposedValue: undefined });
    await normalEdit({ ...edit });
    expect((await service.detail(r.id, admin)).flags[0]).toMatchObject({ conflict: true, baselineValue: baseline, proposedValue: baseline });
  });

  test.each(changes)('%s changed and reverted still invalidates an admin comparison', async (_part, edit) => {
    await seedPair();
    const r = await submit(await create(['availabilityReview']), 0, { proposedValue: proposal });
    await normalEdit({ ...edit });
    const comparison = await service.detail(r.id, admin);
    await normalEdit({ availability: baseline.availability, availabilityLastReviewedOn: new Date(baseline.availabilityLastReviewedOn) });
    await expect(service.decide(r.id, r.flags[0].id, decision(comparison.flags[0], {
      choice: 'PROPOSED', reason: 'Owner confirmed both values.', confirmed: true,
    }), admin)).rejects.toMatchObject({ code: 'CURRENT_CHANGED' });
    const fresh = await service.detail(r.id, admin);
    expect(fresh.flags[0]).toMatchObject({ conflict: true, currentValue: baseline, currentVersion: r.flags[0].currentVersion + 2 });
    expect(pair(await live())).toEqual(baseline);
  });

  test('availability with an existing review date can be corrected and closed together; unrelated edits do not conflict', async () => {
    await seedPair();
    const corrected = { availability: 'No', availabilityLastReviewedOn: null };
    const r = await submit(await create(['availabilityReview']), 0, { proposedValue: corrected });
    expect(pair(await live())).toEqual(baseline);
    await normalEdit({ ratePerSqft: '25' });
    const fresh = await service.detail(r.id, admin);
    expect(fresh.flags[0].conflict).toBe(false);
    const done = await service.decide(r.id, fresh.flags[0].id, decision(fresh.flags[0]), admin);
    expect(pair(await live())).toEqual(corrected);
    expect((await live()).ratePerSqft).toBe('25');
    expect(done.closedAt).not.toBeNull();
    const history = await service.history(r.id, fresh.flags[0].id, admin);
    expect(history.items[0]).toMatchObject({ oldValue: baseline, newValue: corrected, actorEmail: admin.email, source: 'Field review verification' });
    expect(history.items[0].version).toBe(fresh.flags[0].currentVersion + 1);
  });

  test('failure while closing a flag rolls back both values and their shared revision/history', async () => {
    await seedPair();
    const r = await submit(await create(['availabilityReview']), 0, { proposedValue: { availability: 'No', availabilityLastReviewedOn: '2026-11-16' } });
    const edits = await db.warehouseFieldEdit.count();
    await db.$executeRawUnsafe('ALTER TABLE "WarehouseFieldReviewEvent" ADD CONSTRAINT test_fail_pair CHECK (action <> \'VERIFIED\')');
    try {
      await expect(service.decide(r.id, r.flags[0].id, decision(r.flags[0]), admin)).rejects.toBeTruthy();
    } finally {
      await db.$executeRawUnsafe('ALTER TABLE "WarehouseFieldReviewEvent" DROP CONSTRAINT test_fail_pair');
    }
    expect(pair(await live())).toEqual(baseline);
    expect(await db.warehouseFieldEdit.count()).toBe(edits);
    expect((await service.detail(r.id, admin)).flags[0]).toMatchObject({ status: 'AWAITING_ADMIN', currentVersion: r.flags[0].currentVersion });
  });

  test('legacy history identifies the recorded availability part without inventing its missing partner', async () => {
    const r = await create(['availabilityReview']);
    await db.auditLog.create({ data: { entity: 'warehouse', entityId: '4821', action: 'UPDATE', userEmail: 'earlier@wareongo.com', metadata: { changes: [
      { field: 'availability', from: 'Yes', to: 'No' },
      { field: 'availabilityLastReviewedOn', from: null, to: '2026-11-10' },
    ] } } });
    expect((await service.detail(r.id, admin)).flags[0].hasEditHistory).toBe(true);
    const history = await service.history(r.id, r.flags[0].id, admin);
    expect(history.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ partLabel: 'Availability', oldValue: 'Yes', newValue: 'No' }),
      expect.objectContaining({ partLabel: 'Availability last reviewed', oldValue: null, newValue: '2026-11-10' }),
    ]));
  });
});


test('dashboard filters, counts and suggestions cover only the assigned queue across pages', async () => {
  await db.warehouse.update({ where: { id: 4821 }, data: {
    warehouseOwnerType: 'Individual', availability: 'Yes', isBroker: 'Yes',
    listing_type: 'Rent', status: 'Ready', visibility: true,
    WarehouseData: { create: { fireNocAvailable: true, landType: 'Warehouse CLU' } }
  } });
  const template = await live();
  for (const [id, city, state, warehouseType, assigneeId] of [
    [4822, 'Ahmedabad', 'Gujarat', 'RCC', 2],
    [4823, 'Private city', 'Private state', 'Private type', 3]
  ]) {
    await db.warehouse.create({ data: { ...template, id, city, state, warehouseType } });
    await service.create({ requestId: randomUUID(), warehouseId: id, assigneeId,
      fields: [{ key: 'ratePerSqft', comment: 'Confirm rate.' }]
    }, admin);
  }
  await create();
  const first = await service.list(employee, { limit: 1 });
  const second = await service.list(employee, { limit: 1, page: 2 });
  expect(first.pagination).toMatchObject({ total: 2, totalPages: 2 });
  expect(first.data).toHaveLength(1);
  expect(second.data).toHaveLength(1);
  expect(new Set([...first.data, ...second.data].map(r => r.warehouseId))).toEqual(new Set([4821, 4822]));
  expect(first.filterOptions).toHaveLength(2);
  expect(first.filterOptions).toEqual(expect.arrayContaining([
    { state: 'Maharashtra', city: 'Bhiwandi', warehouseType: 'PEB' },
    { state: 'Gujarat', city: 'Ahmedabad', warehouseType: 'RCC' }
  ]));
  const filtered = await service.list(employee, {
    state: 'maharashtra', city: 'bhiwandi', zone: 'west', warehouseType: 'PEB',
    warehouseOwnerType: 'Individual', contactPerson: 'Fixture Owner',
    availability: 'Yes', isBroker: 'y', listing_type: 'Rent', status: 'Ready',
    uploadedBy: 'Employee One', visibility: 'visible', fireNoc: 'available', landType: 'CLU',
    minArea: 40000, maxArea: 60000, minRate: 20, maxRate: 22.5
  });
  expect(filtered.data.map(r => r.warehouseId)).toEqual([4821]);
  expect(filtered.counts).toEqual({ current: 1, previous: 0 });
  expect(filtered.filterOptions).toEqual(first.filterOptions);
  expect((await service.list(employee, { minArea: 50001 })).data).toEqual([]);
  expect((await service.list(employee, { fireNoc: 'not_available' })).data.map(r => r.warehouseId)).toEqual([4822]);
  const inaccessible = await service.list(employee, { search: '4823', assigneeId: 3 });
  expect(inaccessible.data).toEqual([]);
  expect(inaccessible.counts.current).toBe(0);
  expect(inaccessible.filterOptions).toEqual(first.filterOptions);
  const pasted = await service.list(employee, { search: '4823, 4821, 4822' });
  expect(new Set(pasted.data.map(r => r.warehouseId))).toEqual(new Set([4821, 4822]));
  expect((await service.list(employee, { search: 'Fixture Owner' })).pagination.total).toBe(2);
  expect((await service.list(admin, { view: 'employee', assigneeId: 3 })).filterOptions).toEqual([
    { state: 'Private state', city: 'Private city', warehouseType: 'Private type' }
  ]);
});

test('warehouse view permissions also constrain assigned review detail, history, summaries and queue counts', async () => {
  const review = await create();
  await db.verifiedNumber.update({ where: { id: 2 }, data: { viewAllWarehouseEntries: false, editAllWarehouseEntries: false } });
  await expect(service.detail(review.id, employee)).rejects.toMatchObject({ statusCode: 403 });
  await expect(service.events(review.id, employee)).rejects.toMatchObject({ statusCode: 403 });
  expect(await service.summaries([4821], employee)).toEqual([]);
  const queue = await service.list(employee);
  expect(queue.data).toEqual([]);
  expect(queue.counts.current).toBe(0);
  expect(queue.filterOptions).toEqual([]);
  expect((await service.list(employee, { search: '4821' })).data).toEqual([]);
  // Legacy display names never confer ownership; a recorded email does.
  await db.warehouse.update({ where: { id: 4821 }, data: { uploadedBy: employee.email.toUpperCase() } });
  expect((await service.detail(review.id, employee)).canRespond).toBe(true);
  expect((await service.list(employee)).pagination.total).toBe(1);
  expect((await service.list(employee)).filterOptions).toEqual([
    { state: 'Maharashtra', city: 'Bhiwandi', warehouseType: 'PEB' }
  ]);
  expect(await service.summaries([4821], employee)).toHaveLength(1);
});

test('revoked edit permissions make assigned reviews read-only and block responses', async () => {
  const review = await create();
  await db.verifiedNumber.update({ where: { id: 2 }, data: { editOwnWarehouseEntries: false } });
  expect((await service.detail(review.id, employee)).canRespond).toBe(false);
  await expect(submit(review)).rejects.toMatchObject({ statusCode: 403 });
  expect((await service.detail(review.id, admin)).flags[0].status).toBe('NEEDS_RESPONSE');
});

test('assignment choices require permission to respond to this warehouse', async () => {
  await db.warehouse.update({ where: { id: 4821 }, data: { uploadedBy: employee.email } });
  await db.verifiedNumber.updateMany({ where: { id: { in: [2, 3] } }, data: { viewAllWarehouseEntries: false, editAllWarehouseEntries: false } });
  const setup = await service.setup(4821, admin);
  expect(setup.defaultAssigneeId).toBe(2);
  expect(setup.assignees.map(p => p.id)).toEqual([1, 2]);
  await expect(service.create({ requestId: randomUUID(), warehouseId: 4821, assigneeId: 3,
    fields: [{ key: 'ratePerSqft', comment: 'Check.' }],
  }, admin)).rejects.toMatchObject({ code: 'ASSIGNEE_REQUIRED' });
  expect(await db.warehouseFieldReview.count()).toBe(0);
  const r = await create(['ratePerSqft']);
  expect(r.assignees.map(p => p.id)).toEqual([1, 2]);
  await expect(service.reassign(r.id, { requestId: randomUUID(), version: r.version, assigneeId: 3 }, admin))
    .rejects.toMatchObject({ code: 'INVALID_ASSIGNEE' });
  expect((await service.detail(r.id, employee)).canRespond).toBe(true);
});

test('a read-only uploader is not offered for new work, and revoked assignees are identifiable', async () => {
  const r = await create(['ratePerSqft']);
  await db.verifiedNumber.update({ where: { id: 2 }, data: { editOwnWarehouseEntries: false, editAllWarehouseEntries: false } });
  const detail = await service.detail(r.id, admin);
  expect(detail.assignee.id).toBe(2);
  expect(detail.assigneeCanRespond).toBe(false);
  expect(detail.assignees.some(p => p.id === 2)).toBe(false);
  await expect(create(['numberOfDocks'])).rejects.toMatchObject({ code: 'ASSIGNEE_REQUIRED' });
  await db.warehouseFieldReviewEvent.deleteMany();
  await db.warehouseFieldFlag.deleteMany();
  await db.warehouseFieldReview.deleteMany();
  expect((await service.setup(4821, admin)).defaultAssigneeId).toBeNull();
});

test('migration security failure rolls back its tables, triggers and grants', async () => {
  const isolated = 'behavior_qa_' + randomBytes(8).toString('hex');
  const isolatedUrl = new URL(base);
  isolatedUrl.searchParams.set('schema', isolated);
  const migrationDb = new PrismaClient({ datasources: { db: { url: isolatedUrl.toString() } } });
  let roleCreated = false;
  try {
    await root.$executeRawUnsafe('CREATE SCHEMA ' + q(isolated));
    await migrationDb.$executeRawUnsafe('CREATE TABLE "Warehouse" (id integer PRIMARY KEY)');
    await migrationDb.$executeRawUnsafe('CREATE TABLE "WarehouseData" (id integer PRIMARY KEY, "warehouseId" integer)');
    // An inherited owner grant survives direct table REVOKEs. The migration
    // must detect this unsafe API access and roll back before installing hooks.
    expect(await root.$queryRawUnsafe("SELECT rolname FROM pg_roles WHERE rolname='anon'")).toHaveLength(0);
    await root.$executeRawUnsafe('CREATE ROLE anon NOLOGIN');
    roleCreated = true;
    await root.$executeRawUnsafe('GRANT warehouse_test TO anon');
    await expect(migrate(migrationDb, true)).rejects.toThrow('database protections');
    expect(await migrationDb.$queryRawUnsafe("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name LIKE 'WarehouseField%'")).toHaveLength(0);
    expect(await migrationDb.$queryRawUnsafe("SELECT trigger_name FROM information_schema.triggers WHERE trigger_schema=current_schema() AND trigger_name='field_review_track_edit'")).toHaveLength(0);
  } finally {
    await migrationDb.$disconnect();
    await root.$executeRawUnsafe('DROP SCHEMA IF EXISTS ' + q(isolated) + ' CASCADE');
    if (roleCreated) {
      await root.$executeRawUnsafe('REVOKE warehouse_test FROM anon');
      await root.$executeRawUnsafe('DROP ROLE anon');
    }
  }
});
