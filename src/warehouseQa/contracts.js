const { z } = require('zod');
const warehouseId = z.number().int().positive().max(2147483647);
const warehouseIds = z
  .array(warehouseId)
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, 'Warehouse IDs must be unique.');
const run = z
  .object({
    request_id: z.uuid(),
    warehouse_ids: warehouseIds,
    mode: z.enum(['BACKFILL', 'NEW_SUBMISSION', 'RECHECK']).default('BACKFILL'),
    model: z.literal('gpt-6.2-sol').default('gpt-6.2-sol')
  })
  .strict();
const cron = z
  .object({
    request_id: z.uuid(),
    warehouse_ids: warehouseIds.optional(),
    since: z.iso.datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(100).default(100)
  })
  .strict()
  .refine((body) => !(body.warehouse_ids && body.since), 'Use explicit IDs or a forward scan, not both.');
const base = z.object({ request_id: z.uuid(), expected_version: z.number().int().nonnegative() });
const field = z.string().min(1).max(100);
const note = z.string().trim().max(500);
const reasons = ['INCORRECT', 'DUPLICATE', 'NOT_ACTIONABLE', 'INSUFFICIENT_EVIDENCE', 'OUT_OF_SCOPE'];
const review = z
  .object({
    machine: z
      .array(
        z
          .object({
            field_key: field,
            decision: z.enum(['APPROVED', 'REJECTED']),
            note: note.min(1),
            reason: z.enum(reasons).nullable().optional()
          })
          .strict()
      )
      .max(100),
    human: z
      .array(
        z
          .object({
            field_key: field,
            note: note.min(1),
            missed_rule_id: z.string().max(100).nullable().optional()
          })
          .strict()
      )
      .max(100)
  })
  .strict()
  .refine((value) => {
    const keys = [...value.machine, ...value.human].map((item) => item.field_key);
    return new Set(keys).size === keys.length;
  }, 'Review fields must be unique.');
const mutations = {
  retry: base.strict(),
  decision: base
    .extend({
      field_key: field,
      decision: z.enum(['APPROVED', 'REJECTED', 'PENDING']),
      note: note.default(''),
      reason: z.enum(reasons).nullable().optional()
    })
    .strict(),
  'admin-flags': base
    .extend({
      field_key: field,
      note: note.min(1),
      missed_rule_id: z.string().max(100).nullable().optional()
    })
    .strict(),
  'remove-admin-flag': base.extend({ field_key: field }).strict(),
  'review-clean': base.extend({ field_key: field, note: note.default('') }).strict(),
  confirm: base.extend({ assignee_id: warehouseId.nullable().optional(), review: review.optional() }).strict()
};
module.exports = { run, cron, mutations, warehouseId, reasons };
