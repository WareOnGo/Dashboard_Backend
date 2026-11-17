/**
 * Formats a warehouse's handover timing for PPT index/detail tables and the
 * Last Mile Excel workbook. Both exports follow the same handover SOP.
 *
 * Handover is recorded two different ways, discriminated by `handoverType`:
 *
 *   FIXED     - a known calendar date in `handoverDate`
 *   VARIABLE  - a lead time in `handoverLeadValue` + `handoverLeadUnit`
 *               (e.g. 2 + MONTHS); an inactive fixed date may remain stored
 *
 * Rows predating that migration have `handoverType` null and carry only
 * `handoverDate`; they take the FIXED path, which is also the legacy
 * behaviour.
 *
 * A site reads as immediately available when the recorded date has already
 * passed or falls inside the next two weeks. Missing or invalid timing in the
 * selected mode is "Unconfirmed", regardless of the availability field. Inactive
 * values retained from another mode cannot confirm the selected mode's timing.
 *
 * Comparison is done on calendar days in UTC. Prisma returns `@db.Date`
 * columns as a Date pinned to UTC midnight, so reading UTC components keeps
 * us on the same calendar date that was stored no matter what timezone the
 * container runs in.
 */

const { parseHandoverDate, parseHandoverLeadValue } = require('../../utils/handoverTiming');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const IMMEDIATE_WINDOW_DAYS = 14;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const IMMEDIATE = 'Immediate';
const UNKNOWN_HANDOVER = 'Unconfirmed';

// Singular/plural noun for each HandoverLeadUnit enum value. An unrecognised
// unit — an enum value added to the DB before this map is updated —
// resolves to null and falls back to UNKNOWN_HANDOVER rather than rendering
// something like "2 undefined".
//
// Capitalised because these appear alongside " Post LOI" below, and a mixed-case
// "1 month Post LOI" reads as a formatting bug on a slide.
const LEAD_UNIT_NOUNS = {
    DAYS: ['Day', 'Days'],
    WEEKS: ['Week', 'Weeks'],
    MONTHS: ['Month', 'Months'],
};

// A variable lead time is counted from the letter of intent, not from the date the
// deck was generated, and a bare "1 Month" invites a client to read it as the
// latter. Only the LEAD-TIME path carries this: a FIXED handover is an absolute
// calendar date that an LOI does not move, and neither 'Immediate' nor
// 'Unconfirmed' is a duration to count from anything.
const POST_LOI = 'Post LOI';

// Whole days since the epoch for a Date's UTC calendar day, so two dates can be
// differenced without any wall-clock time component leaking in.
const utcDayIndex = (date) => Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / MS_PER_DAY
);

// '2 Months Post LOI', '1 Month Post LOI', '15 Days Post LOI'. Sits under an
// "Handover" label, so it reads as the answer to "when" the same
// way 'Immediate' does — with the reference point stated, which a bare duration
// leaves to the reader.
function formatLeadTime(value, unit) {
    if (typeof unit !== 'string' || !Object.hasOwn(LEAD_UNIT_NOUNS, unit)) return UNKNOWN_HANDOVER;
    const nouns = LEAD_UNIT_NOUNS[unit];

    const n = parseHandoverLeadValue(value);
    if (n == null) return UNKNOWN_HANDOVER;
    // Preserve explicitly recorded zero leads; new dashboard entries use 1–120.
    if (n === 0) return IMMEDIATE;

    return `${n} ${n === 1 ? nouns[0] : nouns[1]} ${POST_LOI}`;
}

function formatFixedHandover(handoverDate, now) {
    const date = parseHandoverDate(handoverDate);
    if (!date) return UNKNOWN_HANDOVER;

    if (utcDayIndex(date) - utcDayIndex(now) <= IMMEDIATE_WINDOW_DAYS) return IMMEDIATE;

    return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * @param {object|Date|string|null|undefined} warehouse - A warehouse row, read
 *   for `handoverType`, `handoverDate`, `handoverLeadValue`, `handoverLeadUnit`.
 *   A bare Date/string is accepted as the pre-migration date-only form.
 * @param {Date} [now] - Reference "today", captured once per export by deck builders
 * @returns {string} 'Immediate', a lead time like '2 Months Post LOI', a formatted
 *   date like '15 Sep 2026', or 'Unconfirmed'
 */
function formatHandover(warehouse, now = new Date()) {
    // Accept the old date-only call shape as well as warehouse rows.
    if (warehouse == null) return UNKNOWN_HANDOVER;
    if (warehouse instanceof Date || typeof warehouse === 'string') {
        return formatFixedHandover(warehouse, now);
    }

    if (warehouse.handoverType === 'VARIABLE') {
        return formatLeadTime(warehouse.handoverLeadValue, warehouse.handoverLeadUnit);
    }

    // Legacy rows without a mode used a fixed date. An unknown explicit mode
    // cannot safely select either side of a row that may retain both values.
    if (warehouse.handoverType != null && warehouse.handoverType !== 'FIXED') return UNKNOWN_HANDOVER;

    return formatFixedHandover(warehouse.handoverDate, now);
}

module.exports = { formatHandover };
