// Shared by write validation and exports: invalid input must not become a valid
// date or duration through coercion before the export formatter sees it.
function parseHandoverDate(value) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value !== 'string') return null;
    const iso = value.trim();
    const match = /^(\d{4}-\d{2}-\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.exec(iso);
    if (!match || iso.startsWith('0000-')) return null;
    // JavaScript otherwise rolls February 30 into March.
    const calendarDate = new Date(`${match[1]}T00:00:00.000Z`);
    if (Number.isNaN(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== match[1]) return null;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
}

function parseHandoverLeadValue(value) {
    // Empty strings, booleans and arrays must never turn into zero or one.
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return null;
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 && n <= 120 ? n : null;
}

module.exports = { parseHandoverDate, parseHandoverLeadValue };
