/**
 * Formats a warehouse's handover timing into the text shown in a deck's
 * "Handover" row and the index table's "Availability" column.
 *
 * Handover is recorded two different ways, discriminated by `handoverType`:
 *
 *   FIXED     - a known calendar date in `handoverDate`
 *   VARIABLE  - a lead time in `handoverLeadValue` + `handoverLeadUnit`
 *               (e.g. 2 + MONTHS), with `handoverDate` deliberately null
 *
 * Rows predating that migration have `handoverType` null and carry only
 * `handoverDate`; they take the FIXED path, which is also the legacy
 * behaviour.
 *
 * A site reads as immediately available when there is no date on record, or
 * when the recorded date has already passed or falls inside the next two
 * weeks — that much lead time reads as "now" to a tenant, and the buffer
 * stops a deck going stale between generation and the client opening it.
 *
 * Comparison is done on calendar days in UTC. Prisma returns `@db.Date`
 * columns as a Date pinned to UTC midnight, so reading UTC components keeps
 * us on the same calendar date that was stored no matter what timezone the
 * container runs in.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const IMMEDIATE_WINDOW_DAYS = 14;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const IMMEDIATE = 'Immediate';
// Used when a site is flagged VARIABLE but its lead time is missing or
// unrecognised. Deliberately not 'Immediate': the row asserts the site is
// *not* ready now, so claiming otherwise would misinform the client. Matches
// the 'On request' idiom already used for absent commercials.
const UNKNOWN_LEAD = 'On request';

// Singular/plural noun for each HandoverLeadUnit enum value. An unrecognised
// unit — a sixth enum value added to the DB before this map is updated —
// resolves to null and falls back to UNKNOWN_LEAD rather than rendering
// something like "2 undefined".
const LEAD_UNIT_NOUNS = {
    DAYS: ['day', 'days'],
    WEEKS: ['week', 'weeks'],
    MONTHS: ['month', 'months'],
};

// Accepts a Date (the Prisma shape) or an ISO string (fixtures / JSON payloads
// that have been through a serialization hop). Anything unparseable — including
// the free-text values the legacy `availability` column carried — yields null
// and therefore falls back to "Immediate".
const parseHandoverDate = (value) => {
    if (value == null) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

// Whole days since the epoch for a Date's UTC calendar day, so two dates can be
// differenced without any wall-clock time component leaking in.
const utcDayIndex = (date) => Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / MS_PER_DAY
);

// '2 months', '1 month', '15 days'. Sits under an "Availability"/"Handover"
// label, so the bare duration reads as the answer to "when" the same way
// 'Immediate' does.
function formatLeadTime(value, unit) {
    const nouns = LEAD_UNIT_NOUNS[unit];
    if (!nouns) return UNKNOWN_LEAD;

    // Guard before coercing: Number(null) and Number('') are both 0, which
    // would fall through to the zero-lead branch below and report a site with
    // no recorded lead time as immediately available.
    if (value == null || value === '') return UNKNOWN_LEAD;

    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return UNKNOWN_LEAD;
    // A zero-length lead time is availability now, by any reading.
    if (n === 0) return IMMEDIATE;

    return `${n} ${n === 1 ? nouns[0] : nouns[1]}`;
}

function formatFixedHandover(handoverDate, now) {
    const date = parseHandoverDate(handoverDate);
    if (!date) return IMMEDIATE;

    if (utcDayIndex(date) - utcDayIndex(now) <= IMMEDIATE_WINDOW_DAYS) return IMMEDIATE;

    return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * @param {object|Date|string|null|undefined} warehouse - A warehouse row, read
 *   for `handoverType`, `handoverDate`, `handoverLeadValue`, `handoverLeadUnit`.
 *   A bare Date/string is accepted as the pre-migration date-only form.
 * @param {Date} [now] - Reference "today"; injectable for tests
 * @returns {string} 'Immediate', a lead time like '2 months', a formatted date
 *   like '15 Sep 2026', or 'On request'
 */
function formatHandover(warehouse, now = new Date()) {
    // Tolerate the old date-only call shape so a missed call site degrades to
    // the previous behaviour instead of silently reading handoverType off a
    // Date and reporting 'Immediate'.
    if (warehouse == null) return IMMEDIATE;
    if (warehouse instanceof Date || typeof warehouse === 'string') {
        return formatFixedHandover(warehouse, now);
    }

    if (warehouse.handoverType === 'VARIABLE') {
        return formatLeadTime(warehouse.handoverLeadValue, warehouse.handoverLeadUnit);
    }

    return formatFixedHandover(warehouse.handoverDate, now);
}

module.exports = { formatHandover };
