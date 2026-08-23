// src/utils/auditDiff.js

/**
 * Field-level diffing for audit log entries.
 *
 * UPDATE audit entries record not just *which* fields changed but the
 * before/after values, so a reviewer can reconstruct what an edit actually did
 * without diffing DB backups. Two constraints shape this module:
 *
 *  1. Audit metadata must never become a side channel for redacted data.
 *     Contact numbers are permission-gated and their reveal is separately
 *     audited, so phone-like fields are masked here (last 4 digits kept) —
 *     enough to see that a number changed, not enough to read it.
 *  2. Audit rows must stay small. Warehouse rows carry photo arrays, media
 *     JSON and raw submission payloads; those are summarized rather than
 *     inlined so one edit can't write a megabyte-sized audit row.
 */

/** Values of these fields are masked, never recorded verbatim. */
const SENSITIVE_FIELDS = new Set([
    'contactNumber',
    'alt_phone_number',
    'submitterPhone',
    'phone_number',
]);

/**
 * Fields excluded from every diff: bookkeeping columns that change on
 * literally every write and whose information is already on the audit row
 * itself (userEmail, userName, createdAt).
 */
const IGNORED_FIELDS = new Set([
    'updatedBy',
    'updatedByEmail',
    'lastModified',
    'updatedAt',
    'status_updated_at',
    'reviewerEmail',
    'reviewerName',
]);

/** Strings longer than this are truncated in recorded values. */
const MAX_STRING_LENGTH = 300;
/** Arrays longer than this are summarized instead of inlined. */
const MAX_ARRAY_LENGTH = 20;
/** Objects whose JSON exceeds this are summarized instead of inlined. */
const MAX_OBJECT_JSON_LENGTH = 1000;

/**
 * Mask a sensitive value, keeping only its last 4 characters.
 * @param {*} value
 * @returns {string|null} e.g. "•••••••3210", or null for empty values
 */
function maskValue(value) {
    if (value == null || value === '') return null;
    const str = String(value);
    if (str.length <= 4) return '•'.repeat(str.length);
    return '•'.repeat(str.length - 4) + str.slice(-4);
}

function isPlainObject(value) {
    return typeof value === 'object'
        && value !== null
        && !Array.isArray(value)
        && !(value instanceof Date);
}

function truncateString(str) {
    return str.length <= MAX_STRING_LENGTH
        ? str
        : `${str.slice(0, MAX_STRING_LENGTH)}… (${str.length} chars)`;
}

/**
 * Reduce a value to something safe to store on an audit row: primitives pass
 * through, long strings are truncated, and big arrays/objects collapse to a
 * `{ __summary }` descriptor so the entry stays readable and bounded.
 * @param {*} value
 * @returns {*} JSON-serializable summary of the value
 */
function summarizeValue(value) {
    if (value === undefined || value === null) return null;
    if (value instanceof Date) return value.toISOString();

    const type = typeof value;
    if (type === 'number' || type === 'boolean') return value;
    if (type === 'bigint') return value.toString();
    if (type === 'string') return truncateString(value);

    if (Array.isArray(value)) {
        if (value.length > MAX_ARRAY_LENGTH) {
            return {
                __summary: 'array',
                length: value.length,
                sample: value.slice(0, 3).map(summarizeValue),
            };
        }
        return value.map(summarizeValue);
    }

    if (isPlainObject(value)) {
        let json;
        try {
            json = JSON.stringify(value);
        } catch {
            return { __summary: 'object', keys: Object.keys(value) };
        }
        if (json && json.length > MAX_OBJECT_JSON_LENGTH) {
            return {
                __summary: 'object',
                keys: Object.keys(value),
                bytes: json.length,
            };
        }
        return value;
    }

    // Functions, symbols and anything else exotic never belong in an audit row.
    return String(value);
}

/**
 * Record one field's before/after pair, masking it if the field is sensitive.
 * @param {string} path - Dotted field path, e.g. "warehouseData.latitude"
 * @param {string} field - Leaf field name, used for the sensitivity check
 * @param {*} from
 * @param {*} to
 * @returns {{field: string, from: *, to: *, masked?: boolean}}
 */
function buildChange(path, field, from, to) {
    if (SENSITIVE_FIELDS.has(field)) {
        return { field: path, from: maskValue(from), to: maskValue(to), masked: true };
    }
    return { field: path, from: summarizeValue(from), to: summarizeValue(to) };
}

/**
 * True when two values are equal for audit purposes. Dates compare by instant,
 * everything else structurally, and null/undefined are the same "empty".
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function isEqual(a, b) {
    const left = a instanceof Date ? a.toISOString() : (a ?? null);
    const right = b instanceof Date ? b.toISOString() : (b ?? null);
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    } catch {
        return left === right;
    }
}

/**
 * Compute a field-level diff between a stored row and the edits applied to it.
 *
 * Only fields present in `after` are considered, so a partial update (a PATCH
 * touching three columns) yields at most three changes rather than a diff
 * against every column on the row.
 *
 * @param {Object} before - The row as it was, before the write
 * @param {Object} after - The edits being applied (partial)
 * @param {Object} [options]
 * @param {string[]} [options.nested=[]] - Keys in `after` holding a nested
 *   object of fields to diff one level deeper (e.g. "warehouseData"). Reported
 *   as "<key>.<field>".
 * @param {string[]} [options.ignore=[]] - Extra field names to skip, on top of
 *   the built-in bookkeeping columns.
 * @returns {Array<{field: string, from: *, to: *, masked?: boolean}>} One entry
 *   per changed field, in `after` key order. Empty when nothing changed.
 */
function computeChanges(before = {}, after = {}, options = {}) {
    const nested = new Set(options.nested || []);
    const ignore = new Set([...IGNORED_FIELDS, ...(options.ignore || [])]);
    const changes = [];

    for (const [field, to] of Object.entries(after || {})) {
        if (ignore.has(field)) continue;

        if (nested.has(field) && isPlainObject(to)) {
            const beforeNested = isPlainObject(before?.[field]) ? before[field] : {};
            for (const [subField, subTo] of Object.entries(to)) {
                if (ignore.has(subField)) continue;
                const subFrom = beforeNested[subField];
                if (isEqual(subFrom, subTo)) continue;
                changes.push(buildChange(`${field}.${subField}`, subField, subFrom, subTo));
            }
            continue;
        }

        const from = before?.[field];
        if (isEqual(from, to)) continue;
        changes.push(buildChange(field, field, from, to));
    }

    return changes;
}

/**
 * Build the standard UPDATE audit metadata payload from a diff.
 * @param {Array<{field: string}>} changes - Output of computeChanges
 * @param {Object} [extra] - Additional metadata merged into the payload
 * @returns {Object} { updatedFields, changeCount, changes, ...extra }
 */
function changeMetadata(changes = [], extra = {}) {
    return {
        updatedFields: changes.map((c) => c.field),
        changeCount: changes.length,
        changes,
        ...extra,
    };
}

module.exports = {
    computeChanges,
    changeMetadata,
    summarizeValue,
    maskValue,
    SENSITIVE_FIELDS,
    IGNORED_FIELDS,
};
