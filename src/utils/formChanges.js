const { z } = require('zod');
const { PPT_FORM_FIELDS, HANDOVER_FIELDS, flatFormValues, pptFormIssues, sameFormAnswer } = require('./pptFormPolicy');
const AVAILABILITY_DETAIL_FIELDS = [{ key: 'status' }, { key: 'lockInDate' }];
const sameAnswer = (key, a, b) => sameFormAnswer(key === 'lockInDate' ? 'handoverDate' : key, a, b);
const formValidationError = issues => Object.assign(new Error(issues[0].message), {
    name: 'ValidationError', statusCode: 400, issues,
});
// Snapshots may contain old missing/legacy answers. They are typed values, never
// Prisma predicates, and are request-only metadata, not warehouse columns.
const expectedFormValuesSchema = z.object({
    ...Object.fromEntries(PPT_FORM_FIELDS.map(field => [field.key, (field.kind === 'boolean' ? z.boolean()
        : field.kind === 'areas' ? z.array(z.number().int()) : z.string()).nullable()])),
    handoverType: z.enum(['FIXED', 'VARIABLE']).nullable(),
    handoverDate: z.union([z.string(), z.date()]).nullable(),
    handoverLeadValue: z.number().int().nullable(),
    handoverLeadUnit: z.enum(['DAYS', 'WEEKS', 'MONTHS']).nullable(),
    // Optional for older Dashboard/Scout clients. Updated forms include these
    // originals so two intentional edits cannot silently overwrite each other.
    status: z.string().nullable().optional(),
    lockInDate: z.union([z.string(), z.date()]).nullable().optional(),
}).strict();

// Drop values the user did not edit, and compare intentional edits against the
// browser's original answers. The later UPDATE guard still closes the DB race.
function prepareFormUpdate(original, edits, expected, { staged = false } = {}) {
    const read = flatFormValues(original), patch = flatFormValues(edits);
    const guardedDetails = AVAILABILITY_DETAIL_FIELDS.filter(field => expected != null && Object.hasOwn(expected, field.key));
    const touched = [...PPT_FORM_FIELDS, ...guardedDetails].filter(field => Object.hasOwn(patch, field.key));
    const timingTouched = HANDOVER_FIELDS.some(key => Object.hasOwn(patch, key));
    if (!touched.length && !timingTouched) return;
    if (expected == null) {
        throw formConflict('Refresh the list and reopen this form before saving. Its original answers are missing.');
    }
    const result = expectedFormValuesSchema.safeParse(expected);
    if (!result.success) throw formValidationError(result.error.issues);
    expected = result.data;
    const remove = field => {
        if (field.nested && !staged) delete edits.warehouseData?.[field.key];
        else delete edits[field.key];
    };
    for (const field of touched) {
        const key = field.key;
        if (sameAnswer(key, patch[key], expected[key]) || sameAnswer(key, patch[key], read[key])) remove(field);
        else if (!sameAnswer(key, read[key], expected[key])) throw formConflict();
    }
    if (timingTouched) {
        const intended = { ...expected, ...Object.fromEntries(HANDOVER_FIELDS.filter(key => Object.hasOwn(patch, key)).map(key => [key, patch[key]])) };
        const equalTiming = (a, b) => HANDOVER_FIELDS.every(key => sameFormAnswer(key, a[key], b[key]));
        if (equalTiming(intended, expected) || equalTiming(intended, read)) HANDOVER_FIELDS.forEach(key => { delete edits[key]; });
        else if (!equalTiming(read, expected)) throw formConflict();
    }
    if (!staged && edits.warehouseData && !Object.keys(edits.warehouseData).length) delete edits.warehouseData;
}

// Compare to the stored row, so unchanged missing/legacy values need no migration
// or historical flags. Accept the master relation and the flat staging mirror.
async function validateFormChanges(original, edits) {
    const issues = pptFormIssues(original, edits);
    if (issues.length) throw formValidationError(issues);
    if (typeof edits.googleLocation === 'string') edits.googleLocation = edits.googleLocation.trim();
    return null;
}

// Compare-and-set predicates are part of the same UPDATE that saves the form.
// This closes the gap between reading an old blank and another editor filling it.
function formUpdateGuard(original, edits, { staged = false } = {}) {
    const before = flatFormValues(original), patch = flatFormValues(edits);
    const root = {}, nested = {};
    for (const field of [...PPT_FORM_FIELDS, ...AVAILABILITY_DETAIL_FIELDS]) {
        if (!Object.hasOwn(patch, field.key)) continue;
        const value = before[field.key] ?? null;
        (field.nested && !staged ? nested : root)[field.key] = Array.isArray(value) ? { equals: value } : value;
    }
    if (HANDOVER_FIELDS.some(key => Object.hasOwn(patch, key))) {
        for (const key of HANDOVER_FIELDS) root[key] = before[key] ?? null;
    }
    if (Object.keys(nested).length) {
        root.WarehouseData = { is: original.WarehouseData || original.warehouseData ? nested : null };
        // Guarded nested edits also advance the parent timestamp. Checking it
        // prevents a relation predicate from using an older statement snapshot
        // after waiting for a concurrent transaction to release the parent lock.
        if (Object.hasOwn(original, 'status_updated_at')) root.status_updated_at = original.status_updated_at;
    }
    return Object.keys(root).length ? root : null;
}
const formConflict = (message = 'Warehouse details changed while this form was open. Refresh the list, reopen the record, and check the latest values before saving.') => Object.assign(new Error(message), {
    name: 'FormConflictError', statusCode: 409, code: 'FORM_FIELDS_CHANGED',
});

module.exports = { validateFormChanges, formValidationError, formUpdateGuard, formConflict, prepareFormUpdate, expectedFormValuesSchema };
