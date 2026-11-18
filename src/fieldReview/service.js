const insensitiveExact = require('../utils/insensitiveExact');
const { CAPS, CAP_COLUMN } = require('../utils/access');
const { effectiveWarehousePermissions, WAREHOUSE_PERMISSION_COLUMNS } = require('../utils/warehousePermissions');
const { warehouseScope, assertWarehouseAccess, canAccessWarehouse } = require('../utils/warehouseAccess');
const {
  createHash
} = require('node:crypto');
const {
  Prisma
} = require('@prisma/client');
const {
  isAdmin
} = require('../utils/admin');
const {
  maskValue
} = require('../utils/auditDiff');
const { resolveTags } = require('../utils/microMarketGeometry');
const { editorIdentity } = require('../utils/editorIdentity');
const { validateFormChanges } = require('../utils/formChanges');
const WarehouseModel = require('../models/warehouseModel');
const WarehouseService = require('../services/warehouseService');
const { parseIdList } = require('../utils/warehouseSearchRanking');
const {
  fields,
  byKey,
  getValue,
  parseValue,
  patchFor,
  jsonValue,
  sameValue,
  handoverKeys,
  availabilityKeys
} = require('./fields');
class ReviewError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'FieldReviewError';
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => {
  throw new ReviewError(status, code, message);
};
const J = value => value == null ? Prisma.JsonNull : jsonValue(value);
const preserveInactiveHandover = (value, current) => value.handoverType === 'VARIABLE'
  ? { ...value, handoverDate: current.handoverDate }
  : { ...value, handoverLeadValue: current.handoverLeadValue, handoverLeadUnit: current.handoverLeadUnit };
const active = {
  not: 'VERIFIED'
};
const rosterSelect = {
  id: true,
  name: true,
  email: true,
  empID: true,
  is_active: true,
  dashboardAccess: true,
  ...Object.fromEntries(WAREHOUSE_PERMISSION_COLUMNS.map(key => [key, true])),
  adminAccess: true,
  reviewerAccess: true
};
const admin = row => !!row?.adminAccess || isAdmin(row?.email);
const reviewer = row => admin(row) || row?.reviewerAccess === true;
const eligible = row => row?.is_active && row.email && (effectiveWarehousePermissions(row).viewOwnWarehouseEntries || admin(row));
const withCapabilities = row => {
  const permissions = { ...row, ...effectiveWarehousePermissions(row) };
  const isAdmin = admin(row);
  return { ...row, isAdmin, isReviewer: reviewer(row), capabilities: Object.fromEntries(Object.entries(CAP_COLUMN)
    .map(([key, column]) => [key, isAdmin || permissions[column] === true])) };
};
const publicPerson = row => row ? {
  id: row.id,
  name: row.name,
  email: row.email
} : null;
const plainWarehouse = row => {
  if (!row) return null;
  const {
    contactNumber,
    alt_phone_number,
    ...visible
  } = row;
  return { ...visible, alt_phone_number: maskValue(alt_phone_number) };
};
function scrubFlag(flag, reveal = false) {
  if (!byKey[flag.fieldKey]?.sensitive || reveal) return flag;
  const copy = {
    ...flag,
    valuesMasked: true
  };
  for (const key of ['originalValue', 'baselineValue', 'proposedValue', 'currentValue', 'finalValue']) copy[key] = maskValue(copy[key]);
  return copy;
}
class FieldReviewService {
  constructor(db, microMarketService = null) {
    this.db = db;
    this.microMarketService = microMarketService;
  }
  async actor(tx, user, reviewerOnly = false) {
    const rows = await tx.verifiedNumber.findMany({
      where: {
        email: insensitiveExact(user.email)
      },
      select: rosterSelect,
      take: 2
    });
    const row = rows.length === 1 ? rows[0] : null;
    if (!eligible(row) || reviewerOnly && !reviewer(row)) fail(403, 'FIELD_REVIEW_FORBIDDEN', 'You do not have access to this action.');
    return withCapabilities(row);
  }
  async roster(tx, warehouse) {
    const rows = await tx.verifiedNumber.findMany({
      where: {
        email: {
          not: null
        }
      },
      select: rosterSelect,
      orderBy: {
        name: 'asc'
      }
    });
    const counts = new Map();
    rows.forEach(r => counts.set(r.email.toLowerCase(), (counts.get(r.email.toLowerCase()) || 0) + 1));
    return rows.filter(r => eligible(r) && counts.get(r.email.toLowerCase()) === 1
      && (!warehouse || canAccessWarehouse(withCapabilities(r), warehouse)));
  }
  async uploader(tx, value, eligiblePeople) {
    const uploaded = String(value || '').trim();
    if (!uploaded) return { id: null, assigneeId: null };
    // Include inactive people in identity matching. A namesake must not inherit
    // a former employee's warehouse just because only one of them is eligible.
    const rows = await tx.verifiedNumber.findMany({
      where: { OR: ['email', 'empID', 'name'].map(key => ({ [key]: insensitiveExact(uploaded) })) },
      select: rosterSelect,
    });
    const identity = rows.filter(row => row.email?.toLowerCase() === uploaded.toLowerCase() || row.empID?.toLowerCase() === uploaded.toLowerCase());
    const matches = identity.length ? identity : rows.filter(row => row.name.trim().toLowerCase() === uploaded.toLowerCase());
    const id = matches.length === 1 ? matches[0].id : null;
    return { id, assigneeId: eligiblePeople.some(person => person.id === id) ? id : null };
  }
  assertOwner(review, actor) {
    if (!actor.isReviewer && review.assigneeId !== actor.id) fail(403, 'FIELD_REVIEW_FORBIDDEN', 'This review is assigned to another employee.');
  }
  async warehouse(tx, id, lock = false) {
    if (lock) {
      await tx.$queryRawUnsafe('SELECT "id" FROM "Warehouse" WHERE "id"=$1 FOR UPDATE', id);
      await tx.$queryRawUnsafe('SELECT "id" FROM "WarehouseData" WHERE "warehouseId"=$1 FOR UPDATE', id);
    }
    const row = await tx.warehouse.findUnique({
      where: {
        id
      },
      include: {
        WarehouseData: true,
        WarehouseProximity: {
          select: {
            category: true,
            status: true,
            landmarkName: true,
            roadKm: true,
            driveMinutes: true,
            warnings: true,
            computedFromLat: true,
            computedFromLng: true
          }
        }
      }
    });
    if (!row && lock) fail(404, 'WAREHOUSE_NOT_FOUND', 'This warehouse no longer exists. Its review history is retained.');
    return row;
  }
  async version(tx, warehouseId, fieldKey) {
    const r = await tx.warehouseFieldVersion.findUnique({
      where: {
        warehouseId_fieldKey: {
          warehouseId,
          fieldKey
        }
      }
    });
    return r?.version || 0;
  }
  async getReview(tx, id, actor) {
    const review = await tx.warehouseFieldReview.findUnique({
      where: {
        id
      },
      include: {
        flags: {
          orderBy: {
            createdAt: 'asc'
          }
        }
      }
    });
    if (!review) fail(404, 'FIELD_REVIEW_NOT_FOUND', 'Review not found.');
    this.assertOwner(review, actor);
    if (!actor.capabilities[CAPS.WAREHOUSE_VIEW_ALL]) {
      const warehouse = await tx.warehouse.findUnique({ where: { id: review.warehouseId }, select: { uploadedBy: true } });
      assertWarehouseAccess(actor, warehouse);
    }
    review.flags.sort((a, b) => fields.findIndex(f => f.key === a.fieldKey) - fields.findIndex(f => f.key === b.fieldKey) || a.id.localeCompare(b.id));
    return review;
  }
  async detailTx(tx, id, actor) {
    const review = await this.getReview(tx, id, actor);
    const warehouse = await this.warehouse(tx, review.warehouseId);
    const versions = await tx.warehouseFieldVersion.findMany({
      where: {
        warehouseId: review.warehouseId
      }
    });
    const versionMap = new Map(versions.map(v => [v.fieldKey, v.version]));
    const assignee = await tx.verifiedNumber.findUnique({
      where: {
        id: review.assigneeId
      },
      select: rosterSelect
    });
    const assignees = actor.isReviewer ? (warehouse ? await this.roster(tx, warehouse) : []) : null;
    const legacy = await tx.auditLog.findMany({
      where: {
        entity: 'warehouse',
        entityId: String(review.warehouseId),
        action: 'UPDATE'
      },
      select: {
        metadata: true
      },
      orderBy: {
        createdAt: 'desc'
      },
      take: 100
    });
    const legacyKeys = new Set(legacy.flatMap(e => (e.metadata?.changes || []).map(c => handoverKeys.includes(c.field) ? 'handover' : availabilityKeys.includes(c.field) ? 'availabilityReview' : c.field)));
    const flags = review.flags.map(flag => {
      const currentVersion = versionMap.get(flag.fieldKey) || 0;
      const currentValue = warehouse ? getValue(warehouse, flag.fieldKey) : null;
      return scrubFlag({
        ...flag,
        field: {
          ...byKey[flag.fieldKey],
          label: flag.labelSnapshot || byKey[flag.fieldKey].label
        },
        currentValue,
        currentVersion,
        replacementRequired: {
          CURRENT: false,
          PROPOSED: !sameValue(flag.proposedValue, currentValue, flag.fieldKey),
          BASELINE: !sameValue(flag.baselineValue, currentValue, flag.fieldKey)
        },
        hasEditHistory: currentVersion > 0 || legacyKeys.has(flag.fieldKey),
        conflict: flag.status === 'AWAITING_ADMIN' && flag.baselineVersion !== currentVersion
      });
    });
    const events = await this.eventsTx(tx, review, null);
    const cycles = await tx.warehouseFieldReview.findMany({
      where: {
        warehouseId: review.warehouseId,
        ...(!actor.isReviewer ? {
          assigneeId: actor.id
        } : {})
      },
      select: {
        id: true,
        createdAt: true,
        closedAt: true
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
    return {
      ...review,
      flags,
      warehouse: plainWarehouse(warehouse),
      assignee: publicPerson(assignee),
      canRespond: actor.id === review.assigneeId && !review.closedAt && !!warehouse && canAccessWarehouse(actor, warehouse),
      assigneeCanRespond: assignees ? assignees.some(r => r.id === review.assigneeId)
        : actor.id === review.assigneeId && !!warehouse && canAccessWarehouse(actor, warehouse),
      canVerify: actor.isReviewer,
      deleted: !warehouse,
      ...events,
      cycles,
      assignees: assignees?.map(publicPerson)
    };
  }
  detail(id, user) {
    return this.db.$transaction(async tx => this.detailTx(tx, id, await this.actor(tx, user)), {
      isolationLevel: 'RepeatableRead'
    });
  }
  async eventsTx(tx, review, cursor) {
    const rows = await tx.warehouseFieldReviewEvent.findMany({
      where: {
        reviewId: review.id
      },
      orderBy: [{
        createdAt: 'desc'
      }, {
        id: 'desc'
      }],
      take: 51,
      ...(cursor ? {
        cursor: {
          id: cursor
        },
        skip: 1
      } : {})
    });
    const flags = review.flags || [];
    return {
      events: rows.slice(0, 50).map(e => {
        const sensitive = byKey[flags.find(f => f.id === e.flagId)?.fieldKey || e.payload?.fieldKey]?.sensitive;
        const payload = {
          ...e.payload
        };
        if (sensitive) for (const k of ['originalValue', 'baselineValue', 'proposedValue', 'currentValue', 'finalValue']) if (k in payload) payload[k] = maskValue(payload[k]);
        return {
          ...e,
          payload,
          requestHash: undefined
        };
      }),
      nextEventCursor: rows.length > 50 ? rows[49].id : null
    };
  }
  events(id, user, cursor) {
    return this.db.$transaction(async tx => {
      const review = await this.getReview(tx, id, await this.actor(tx, user));
      if (cursor && !(await tx.warehouseFieldReviewEvent.findFirst({
        where: {
          id: cursor,
          reviewId: id
        }
      }))) fail(400, 'INVALID_CURSOR', 'Invalid history cursor.');
      return this.eventsTx(tx, review, cursor);
    }, {
      isolationLevel: 'RepeatableRead'
    });
  }
  setup(warehouseId, user) {
    return this.db.$transaction(async tx => {
      const actor = await this.actor(tx, user, true),
        warehouse = await this.warehouse(tx, warehouseId);
      if (!warehouse) fail(404, 'WAREHOUSE_NOT_FOUND', 'Warehouse not found.');
      assertWarehouseAccess(actor, warehouse);
      const people = await this.roster(tx, warehouse);
      const uploader = await this.uploader(tx, warehouse.uploadedBy, people);
      const current = await tx.warehouseFieldReview.findFirst({
        where: {
          warehouseId,
          closedAt: null
        },
        include: {
          flags: {
            where: {
              status: active
            }
          }
        }
      });
      const versions = await tx.warehouseFieldVersion.findMany({
        where: {
          warehouseId
        }
      });
      return {
        fields: fields.map(f => ({
          ...f,
          value: f.sensitive ? maskValue(getValue(warehouse, f.key)) : getValue(warehouse, f.key),
          version: versions.find(v => v.fieldKey === f.key)?.version || 0
        })),
        assignees: people.map(publicPerson),
        defaultAssigneeId: current?.assigneeId ?? uploader.assigneeId,
        uploader: warehouse.uploadedBy,
        existingReviewId: current?.id || null,
        activeFields: current?.flags.map(f => ({
          id: f.id,
          key: f.fieldKey,
          reviewId: current.id
        })) || [],
        actorId: actor.id
      };
    }, {
      isolationLevel: 'RepeatableRead'
    });
  }
  async mutate(warehouseId, user, body, action, run, target = {}) {
    const hash = createHash('sha256').update(JSON.stringify({
      warehouseId,
      action,
      body,
      target
    })).digest('hex');
    return this.db.$transaction(async tx => {
      const warehouse = await this.warehouse(tx, warehouseId, true);
      const actor = await this.actor(tx, user);
      assertWarehouseAccess(actor, warehouse);
      const previous = await tx.warehouseFieldReviewEvent.findUnique({
        where: {
          requestId: body.requestId
        }
      });
      if (previous) {
        if (previous.actorEmail !== actor.email || previous.requestHash !== hash) fail(409, 'REQUEST_REUSED', 'This request ID was already used for a different action.');
        return this.detailTx(tx, previous.reviewId, actor);
      }
      const result = await run(tx, actor, warehouse);
      await tx.warehouseFieldReviewEvent.create({
        data: {
          reviewId: result.reviewId,
          flagId: result.flagId,
          action,
          actorEmail: actor.email,
          actorName: actor.name,
          payload: J(result.payload || {}),
          requestId: body.requestId,
          requestHash: hash
        }
      });
      const open = await tx.warehouseFieldFlag.count({
        where: {
          reviewId: result.reviewId,
          status: active
        }
      });
      await tx.warehouseFieldReview.update({
        where: {
          id: result.reviewId
        },
        data: {
          closedAt: open ? null : new Date(),
          version: {
            increment: 1
          }
        }
      });
      // Prepare the response before committing. A failed snapshot read must
      // roll back the write instead of reporting an error after it succeeded.
      return this.detailTx(tx, result.reviewId, actor);
    }, {
      timeout: 15000
    });
  }
  create(body, user) {
    return this.mutate(body.warehouseId, user, body, 'CREATED', async (tx, actor, warehouse) => {
      if (!actor.isReviewer) fail(403, 'FIELD_REVIEW_FORBIDDEN', 'Only reviewers can flag warehouse fields.');
      const keys = body.fields.map(f => f.key);
      if (new Set(keys).size !== keys.length) fail(400, 'DUPLICATE_FIELDS', 'Select each field once.');
      const duplicate = await tx.warehouseFieldFlag.findFirst({
        where: {
          warehouseId: warehouse.id,
          fieldKey: {
            in: keys
          },
          status: active
        }
      });
      if (duplicate) fail(409, 'ALREADY_FLAGGED', 'A selected field is already under review. Open the existing review.');
      let review = await tx.warehouseFieldReview.findFirst({
        where: {
          warehouseId: warehouse.id,
          closedAt: null
        }
      });
      const roster = await this.roster(tx, warehouse);
      const uploader = await this.uploader(tx, warehouse.uploadedBy, roster);
      const assigneeId = body.assigneeId ?? review?.assigneeId ?? uploader.assigneeId;
      if (!roster.some(r => r.id === assigneeId)) fail(400, 'ASSIGNEE_REQUIRED', 'Select an active employee who can view this warehouse.');
      if (review && review.assigneeId !== assigneeId) fail(409, 'ASSIGNEE_CHANGED', 'This warehouse already has an assignee. Reassign its active review before adding fields.');
      if (!review) review = await tx.warehouseFieldReview.create({
        data: {
          warehouseId: warehouse.id,
          assigneeId,
          uploaderId: uploader.id,
          createdBy: actor.email
        }
      });
      await tx.warehouseFieldFlag.createMany({
        data: body.fields.map(f => ({
          reviewId: review.id,
          warehouseId: warehouse.id,
          fieldKey: f.key,
          labelSnapshot: byKey[f.key].label,
          comment: f.comment,
          createdBy: actor.email,
          originalValue: J(getValue(warehouse, f.key))
        }))
      });
      return {
        reviewId: review.id,
        payload: {
          fields: keys,
          assigneeId
        }
      };
    });
  }
  async withFlag(reviewId, flagId, user, body, action, run) {
    const parent = await this.db.warehouseFieldReview.findUnique({
      where: {
        id: reviewId
      },
      select: {
        warehouseId: true
      }
    });
    if (!parent) fail(404, 'FIELD_REVIEW_NOT_FOUND', 'Review not found.');
    return this.mutate(parent.warehouseId, user, body, action, async (tx, actor, warehouse) => {
      const review = await this.getReview(tx, reviewId, actor),
        flag = review.flags.find(f => f.id === flagId);
      if (!flag) fail(404, 'FIELD_REVIEW_NOT_FOUND', 'Flag not found in this review.');
      if (flag.version !== body.version) fail(409, 'FLAG_CHANGED', 'This field was already updated. Refresh to see its latest status.');
      const result = await run(tx, actor, warehouse, review, flag);
      return {
        reviewId: review.id,
        flagId: flag.id,
        ...result
      };
    }, {
      reviewId,
      flagId
    });
  }
  respond(reviewId, flagId, body, user) {
    return this.withFlag(reviewId, flagId, user, body, 'SUBMITTED', async (tx, actor, warehouse, review, flag) => {
      // The assignment permits proposals for its open flags without granting
      // ordinary warehouse Edit access. View access was checked by mutate.
      if (actor.id !== review.assigneeId) fail(403, 'FIELD_REVIEW_FORBIDDEN', 'Only the assigned employee can submit a response.');
      if (review.closedAt || !['NEEDS_RESPONSE', 'CHANGES_REQUESTED'].includes(flag.status)) fail(409, 'FLAG_CHANGED', 'This field is already awaiting a decision or is closed.');
      const currentVersion = await this.version(tx, warehouse.id, flag.fieldKey);
      if (currentVersion !== body.baselineVersion) fail(409, 'BASELINE_CHANGED', 'The live value changed while you were preparing this response. Review the latest value before resubmitting.');
      const baseline = getValue(warehouse, flag.fieldKey);
      let proposal;
      try {
        proposal = body.resolution === 'NO_CHANGE' ? baseline : parseValue(flag.fieldKey, body.proposedValue);
        if (body.resolution === 'CORRECTION' && flag.fieldKey === 'handover') {
          proposal = preserveInactiveHandover(proposal, baseline);
        }
        if (body.resolution === 'CORRECTION') await validateFormChanges(warehouse, patchFor(flag.fieldKey, proposal));
      } catch (e) {
        fail(400, 'INVALID_FIELD_VALUE', e.issues?.[0]?.message || e.message);
      }
      if (body.resolution === 'CORRECTION' && sameValue(proposal, baseline, flag.fieldKey)) fail(400, 'NO_CHANGE_REQUIRED', 'Choose No change needed and explain how you verified the existing value.');
      const data = {
        baselineValue: J(baseline),
        baselineVersion: currentVersion,
        proposedValue: J(proposal),
        resolution: body.resolution,
        explanation: body.explanation,
        respondedBy: actor.email,
        respondedAt: new Date(),
        status: 'AWAITING_ADMIN',
        version: {
          increment: 1
        }
      };
      await tx.warehouseFieldFlag.update({
        where: {
          id: flag.id
        },
        data
      });
      return {
        payload: {
          fieldKey: flag.fieldKey,
          baselineValue: baseline,
          baselineVersion: currentVersion,
          proposedValue: proposal,
          resolution: body.resolution,
          explanation: body.explanation
        }
      };
    });
  }
  async decide(reviewId, flagId, body, user) {
    // Prepare polygon data before taking warehouse locks. Fetching it through a
    // second database connection inside the transaction can exhaust the pool.
    // Coordinates themselves are still read and compared under the write lock.
    let polygons;
    if (this.microMarketService && body.choice !== 'CURRENT') {
      const field = await this.db.warehouseFieldFlag.findFirst({
        where: { id: flagId, reviewId }, select: { fieldKey: true }
      });
      if (['warehouseData.latitude', 'warehouseData.longitude'].includes(field?.fieldKey)) {
        await this.actor(this.db, user, true);
        try { polygons = await this.microMarketService.getPolygons(); }
        catch { fail(503, 'LOCATION_TAGS_UNAVAILABLE', 'Location areas could not be loaded. Retry verification. No values have changed.'); }
      }
    }
    return this.withFlag(reviewId, flagId, user, body, 'VERIFIED', async (tx, actor, warehouse, review, flag) => {
      if (!actor.isReviewer) fail(403, 'FIELD_REVIEW_FORBIDDEN', 'Only a reviewer can verify a response.');
      if (flag.status !== 'AWAITING_ADMIN') fail(409, 'FLAG_CHANGED', 'Only submitted responses can be verified.');
      const currentVersion = await this.version(tx, warehouse.id, flag.fieldKey),
        current = getValue(warehouse, flag.fieldKey);
      if (body.currentVersion !== currentVersion) fail(409, 'CURRENT_CHANGED', 'The current value changed again. Review the refreshed comparison and confirm a new decision.');
      const conflict = flag.baselineVersion !== currentVersion;
      if (!conflict && body.choice !== 'PROPOSED') fail(400, 'INVALID_DECISION', 'Use the ordinary verification action when the live field has not changed.');
      let final = body.choice === 'CURRENT' ? current : body.choice === 'BASELINE' ? flag.baselineValue : flag.proposedValue;
      const replacing = !sameValue(final, current, flag.fieldKey);
      if (!replacing) final = current;
      if (conflict && replacing && (!body.reason?.trim() || body.confirmed !== true)) fail(400, 'CONFIRMATION_REQUIRED', 'Replacing the current value requires a reason and explicit confirmation.');
      if (replacing) {
        try {
          final = parseValue(flag.fieldKey, final);
        } catch (e) {
          fail(400, 'INVALID_FIELD_VALUE', e.issues?.[0]?.message || e.message);
        }
        if (flag.fieldKey === 'handover') {
          // The comparison/choice covers the selected timing type. Preserve the
          // latest saved timing for the other type rather than overwriting
          // undisplayed values from the employee's older snapshot.
          final = preserveInactiveHandover(final, current);
        }
        try { await validateFormChanges(warehouse, patchFor(flag.fieldKey, final)); }
        catch (e) { fail(400, 'INVALID_FIELD_VALUE', e.issues?.[0]?.message || e.message); }
        await tx.$queryRawUnsafe("SELECT set_config('wareongo.actor_email',$1,true),set_config('wareongo.edit_source','Field review verification',true)", actor.email);
        const patch = patchFor(flag.fieldKey, final);
        // Handover and Availability/Last reviewed are explicit compound fields.
        // Both parts of the availability pair are written in this one update.
        if (patch.warehouseData) {
          const updated = await tx.warehouseData.upsert({
            where: {
              warehouseId: warehouse.id
            },
            create: {
              warehouseId: warehouse.id,
              ...patch.warehouseData
            },
            update: patch.warehouseData
          });
          await tx.warehouse.update({
            where: { id: warehouse.id },
            data: {
              lastEditedBy: editorIdentity(actor),
              ...(polygons ? { micromarket: resolveTags(polygons, updated.latitude, updated.longitude) } : {})
            }
          });
        } else {
          const typed = {
            ...patch,
            lastEditedBy: editorIdentity(actor)
          };
          for (const key of ['handoverDate', 'lockInDate', 'availabilityLastReviewedOn']) if (typed[key] != null) typed[key] = new Date(typed[key]);
          await tx.warehouse.update({
            where: {
              id: warehouse.id
            },
            data: typed
          });
        }
      }
      await tx.warehouseFieldFlag.update({
        where: {
          id: flag.id
        },
        data: {
          status: 'VERIFIED',
          decision: body.choice,
          decisionReason: body.reason || null,
          finalValue: J(final),
          decidedBy: actor.email,
          decidedAt: new Date(),
          version: {
            increment: 1
          }
        }
      });
      return {
        payload: {
          fieldKey: flag.fieldKey,
          baselineValue: flag.baselineValue,
          proposedValue: flag.proposedValue,
          currentValue: current,
          currentVersion,
          finalValue: final,
          choice: body.choice,
          reason: body.reason || null,
          changed: replacing
        }
      };
    });
  }
  returnForChanges(reviewId, flagId, body, user) {
    return this.withFlag(reviewId, flagId, user, body, 'RETURNED', async (tx, actor, warehouse, review, flag) => {
      if (!actor.isReviewer) fail(403, 'FIELD_REVIEW_FORBIDDEN', 'Only reviewers can request changes.');
      if (flag.status !== 'AWAITING_ADMIN') fail(409, 'FLAG_CHANGED', 'Only a submitted response can be returned.');
      await tx.warehouseFieldFlag.update({
        where: {
          id: flag.id
        },
        data: {
          status: 'CHANGES_REQUESTED',
          returnComment: body.comment,
          version: {
            increment: 1
          }
        }
      });
      return {
        payload: {
          fieldKey: flag.fieldKey,
          comment: body.comment
        }
      };
    });
  }
  reopen(reviewId, flagId, body, user) {
    return this.withFlag(reviewId, flagId, user, body, 'REOPENED', async (tx, actor, warehouse, review, flag) => {
      if (!actor.isReviewer) fail(403, 'FIELD_REVIEW_FORBIDDEN', 'Only reviewers can reopen verified flags.');
      if (flag.status !== 'VERIFIED') fail(409, 'FLAG_CHANGED', 'This field is already active.');
      const duplicate = await tx.warehouseFieldFlag.findFirst({
        where: {
          warehouseId: warehouse.id,
          fieldKey: flag.fieldKey,
          status: active
        }
      });
      if (duplicate) fail(409, 'ALREADY_FLAGGED', 'A newer active flag already exists for this field. Open the current review.');
      const current = await tx.warehouseFieldReview.findFirst({
        where: {
          warehouseId: warehouse.id,
          closedAt: null
        }
      });
      if (current && current.id !== review.id) {
        const fresh = await tx.warehouseFieldFlag.create({
          data: {
            warehouseId: warehouse.id,
            reviewId: current.id,
            fieldKey: flag.fieldKey,
            labelSnapshot: byKey[flag.fieldKey].label,
            comment: flag.comment,
            createdBy: actor.email,
            originalValue: J(getValue(warehouse, flag.fieldKey))
          }
        });
        return {
          reviewId: current.id,
          flagId: fresh.id,
          payload: {
            fieldKey: flag.fieldKey,
            previousFlagId: flag.id,
            previousReviewId: review.id
          }
        };
      }
      await tx.warehouseFieldFlag.update({
        where: {
          id: flag.id
        },
        data: {
          status: 'NEEDS_RESPONSE',
          version: {
            increment: 1
          },
          baselineValue: Prisma.DbNull,
          baselineVersion: null,
          proposedValue: Prisma.DbNull,
          resolution: null,
          explanation: null,
          respondedBy: null,
          respondedAt: null,
          returnComment: null,
          decision: null,
          decisionReason: null,
          finalValue: Prisma.DbNull,
          decidedBy: null,
          decidedAt: null
        }
      });
      return {
        payload: {
          fieldKey: flag.fieldKey,
          originalValue: getValue(warehouse, flag.fieldKey)
        }
      };
    });
  }
  async reassign(reviewId, body, user) {
    const parent = await this.db.warehouseFieldReview.findUnique({
      where: {
        id: reviewId
      }
    });
    if (!parent) fail(404, 'FIELD_REVIEW_NOT_FOUND', 'Review not found.');
    return this.mutate(parent.warehouseId, user, body, 'REASSIGNED', async (tx, actor, warehouse) => {
      if (!actor.isReviewer) fail(403, 'FIELD_REVIEW_FORBIDDEN', 'Only reviewers can reassign work.');
      const review = await this.getReview(tx, reviewId, actor);
      if (review.version !== body.version) fail(409, 'REVIEW_CHANGED', 'Review ownership changed. Refresh before reassigning.');
      if (review.closedAt) fail(409, 'REVIEW_CLOSED', 'Reopen a field before reassigning a completed review.');
      if (!(await this.roster(tx, warehouse)).some(r => r.id === body.assigneeId)) fail(400, 'INVALID_ASSIGNEE', 'Choose an active employee who can view this warehouse.');
      await tx.warehouseFieldReview.update({
        where: {
          id: reviewId
        },
        data: {
          assigneeId: body.assigneeId
        }
      });
      return {
        reviewId,
        payload: {
          previousAssigneeId: review.assigneeId,
          assigneeId: body.assigneeId
        }
      };
    }, {
      reviewId
    });
  }
  async historyTx(tx, review, flag, reveal = false) {
    let rows = await tx.warehouseFieldEdit.findMany({
      where: {
        warehouseId: review.warehouseId,
        fieldKey: flag.fieldKey
      },
      orderBy: [{ version: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
      take: 100
    });
    // Once tracking starts, its complete snapshots take precedence over the
    // ordinary audit summary of the same write. Earlier summaries still matter.
    if (rows.length < 100) {
      const legacyFields = flag.fieldKey === 'handover' ? handoverKeys : flag.fieldKey === 'availabilityReview' ? availabilityKeys : [flag.fieldKey];
      const partLabels = { handoverType: 'Handover type', handoverDate: 'Handover date', handoverLeadValue: 'Lead time', handoverLeadUnit: 'Lead time unit', availability: 'Availability', availabilityLastReviewedOn: 'Availability last reviewed' };
      const logs = await tx.auditLog.findMany({
        where: {
          entity: 'warehouse',
          entityId: String(review.warehouseId),
          action: 'UPDATE',
          OR: legacyFields.map(field => ({ metadata: { path: ['changes'], array_contains: [{ field }] } })),
          ...(rows.length ? { createdAt: { lt: rows.at(-1).createdAt } } : {})
        },
        orderBy: {
          createdAt: 'desc'
        },
        take: 100 - rows.length
      });
      rows.push(...logs.flatMap(log => (log.metadata?.changes || []).filter(c => legacyFields.includes(c.field)).map(c => ({
        id: log.id + ':' + c.field,
        fieldKey: c.field,
        partLabel: partLabels[c.field],
        oldValue: c.from,
        newValue: c.to,
        actorEmail: log.userEmail,
        createdAt: log.createdAt,
        source: 'Warehouse audit (recorded summary)',
        masked: !!c.masked
      }))));
    }
    return rows.slice(0, 100).map(r => byKey[flag.fieldKey]?.sensitive && !reveal ? {
      ...r,
      oldValue: maskValue(r.oldValue),
      newValue: maskValue(r.newValue)
    } : r);
  }
  history(reviewId, flagId, user) {
    return this.db.$transaction(async tx => {
      const review = await this.getReview(tx, reviewId, await this.actor(tx, user)),
        flag = review.flags.find(f => f.id === flagId);
      if (!flag) fail(404, 'FIELD_REVIEW_NOT_FOUND', 'Flag not found.');
      return {
        items: await this.historyTx(tx, review, flag),
        limit: 100
      };
    }, {
      isolationLevel: 'RepeatableRead'
    });
  }
  reveal(reviewId, flagId, body, user) {
    return this.db.$transaction(async tx => {
      const actor = await this.actor(tx, user),
        review = await this.getReview(tx, reviewId, actor),
        flag = review.flags.find(f => f.id === flagId);
      if (!flag || !byKey[flag.fieldKey]?.sensitive) fail(400, 'INVALID_REVEAL', 'This field does not need a protected-value reveal.');
      const warehouse = await this.warehouse(tx, review.warehouseId);
      await tx.warehouseFieldReviewEvent.create({
        data: {
          reviewId,
          flagId,
          action: 'REVEALED',
          actorEmail: actor.email,
          actorName: actor.name,
          payload: {
            reason: body.reason,
            fieldKey: flag.fieldKey
          }
        }
      });
      return {
        ...flag,
        currentValue: warehouse ? getValue(warehouse, flag.fieldKey) : null,
        currentVersion: await this.version(tx, review.warehouseId, flag.fieldKey),
        history: await this.historyTx(tx, review, flag, true)
      };
    }, {
      isolationLevel: 'RepeatableRead'
    });
  }
  list(user, {
    view = 'current',
    page = 1,
    limit = 12,
    assigneeId,
    ...filters
  } = {}) {
    return this.db.$transaction(async tx => {
      const actor = await this.actor(tx, user);
      if (!actor.isReviewer && !['current', 'previous'].includes(view)) fail(403, 'FIELD_REVIEW_FORBIDDEN', 'This queue is reviewer-only.');
      const scope = actor.isReviewer ? assigneeId ? {
        assigneeId
      } : {} : {
        assigneeId: actor.id
      };
      let ids;
      const accessWhere = warehouseScope(actor);
      const queueIds = (await tx.warehouseFieldReview.groupBy({
        by: ['warehouseId'], where: scope
      })).map(row => row.warehouseId);
      const queueAccess = { AND: [accessWhere, { id: { in: queueIds } }] };
      // Suggestions cover the entire permitted queue, independent of its page,
      // segment and active filters. No unassigned warehouse metadata is returned.
      const filterOptions = await tx.warehouse.groupBy({
        by: ['state', 'city', 'warehouseType'], where: queueAccess
      });
      const search = filters.search?.trim() || '';
      const hasWarehouseFilters = Object.entries(filters).some(([key, value]) =>
        key !== 'search' && value != null && value !== '');
      if (search || hasWarehouseFilters || accessWhere.uploadedBy) {
        const { where } = await new WarehouseService(new WarehouseModel(tx)).resolveSearch(filters, queueAccess);
        ids = (await tx.warehouse.findMany({
          where,
          select: {
            id: true
          }
        })).map(w => w.id);
        // Deleted warehouses retain searchable history by explicit ID, but have
        // no current attributes to match filters or establish own-entry access.
        if (search && !hasWarehouseFilters && !accessWhere.uploadedBy) {
          const whid = /^\d+$/.test(search) && Number(search) > 0 && Number(search) <= 2147483647 ? Number(search) : null;
          const requestedIds = parseIdList(search)?.ids || (whid ? [whid] : []);
          const assignedIds = new Set(queueIds);
          ids = [...new Set([...ids, ...requestedIds.filter(id => assignedIds.has(id))])];
        }
      }
      const base = {
        ...scope,
        ...(ids ? {
          warehouseId: {
            in: ids
          }
        } : {})
      };
      const states = {
        current: {
          closedAt: null
        },
        previous: {
          closedAt: {
            not: null
          }
        },
        verify: {
          closedAt: null,
          flags: {
            some: {
              status: 'AWAITING_ADMIN'
            }
          }
        },
        employee: {
          closedAt: null,
          flags: {
            none: {
              status: 'AWAITING_ADMIN'
            }
          }
        },
        all: {}
      };
      if (!states[view]) fail(400, 'INVALID_QUEUE', 'Unknown queue segment.');
      const counts = {};
      for (const key of actor.isReviewer ? Object.keys(states) : ['current', 'previous']) {
        counts[key] = (await tx.warehouseFieldReview.groupBy({
          by: ['warehouseId'],
          where: {
            ...base,
            ...states[key]
          }
        })).length;
      }
      const reviews = await tx.warehouseFieldReview.findMany({
        where: {
          ...base,
          ...states[view]
        },
        distinct: ['warehouseId'],
        orderBy: {
          createdAt: 'desc'
        },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          flags: {
            select: {
              status: true,
              resolution: true,
              decision: true
            }
          }
        }
      });
      const warehouses = await tx.warehouse.findMany({
        where: {
          id: {
            in: reviews.map(r => r.warehouseId)
          }
        },
        include: {
          WarehouseData: true
        }
      });
      const people = await tx.verifiedNumber.findMany({
        where: {
          id: {
            in: reviews.map(r => r.assigneeId)
          }
        },
        select: rosterSelect
      });
      return {
        assignees: actor.isReviewer ? (await this.roster(tx)).map(publicPerson) : undefined,
        filterOptions,
        data: reviews.map(r => ({
          ...r,
          warehouse: plainWarehouse(warehouses.find(w => w.id === r.warehouseId)),
          assignee: publicPerson(people.find(p => p.id === r.assigneeId)),
          activeCount: r.flags.filter(f => f.status !== 'VERIFIED').length,
          awaitingCount: r.flags.filter(f => f.status === 'AWAITING_ADMIN').length
        })),
        counts,
        pagination: {
          page,
          limit,
          total: counts[view],
          totalPages: Math.ceil(counts[view] / limit)
        }
      };
    }, {
      isolationLevel: 'RepeatableRead'
    });
  }
  summaries(ids, user) {
    return this.db.$transaction(async tx => {
      const actor = await this.actor(tx, user);
      if (!actor.capabilities[CAPS.WAREHOUSE_VIEW_ALL]) {
        ids = (await tx.warehouse.findMany({
          where: { AND: [warehouseScope(actor), { id: { in: ids } }] }, select: { id: true },
        })).map(row => row.id);
      }
      const reviews = await tx.warehouseFieldReview.findMany({
        where: {
          warehouseId: {
            in: ids
          },
          closedAt: null
        },
        select: {
          id: true,
          warehouseId: true,
          assigneeId: true,
          flags: {
            where: {
              status: active
            },
            select: {
              fieldKey: true,
              comment: true
            }
          }
        }
      });
      return reviews.map(r => ({
        warehouseId: r.warehouseId,
        activeCount: r.flags.length,
        activeFieldKeys: r.flags.map(flag => flag.fieldKey).sort(),
        activeFields: r.flags.map(({ fieldKey, comment }) => ({ fieldKey, comment }))
          .sort((a, b) => a.fieldKey.localeCompare(b.fieldKey)),
        reviewId: actor.isReviewer || r.assigneeId === actor.id ? r.id : null,
        canOpen: actor.isReviewer || r.assigneeId === actor.id
      }));
    }, {
      isolationLevel: 'RepeatableRead'
    });
  }
}
module.exports = {
  FieldReviewService,
  ReviewError
};
