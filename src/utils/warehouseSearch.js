const { Prisma } = require('@prisma/client');

/** Recognize phone-like searches without interpreting addresses such as "Sector 42". */
function phoneSearchDigits(term) {
    if (!term || !/^[+\d\s().-]+$/.test(term)) return null;
    let digits = term.replace(/\D/g, '');

    // Strip Indian dialling prefixes only on complete numbers. In particular,
    // a ten-digit local number starting with 91 must keep those first two digits.
    if (/^0091\d{10}$/.test(digits)) digits = digits.slice(4);
    else if (/^91\d{10}$/.test(digits)) digits = digits.slice(2);
    else if (/^0\d{10}$/.test(digits)) digits = digits.slice(1);

    // Keep short warehouse-ID searches useful while allowing phone fragments.
    return digits.length >= 4 ? digits : null;
}

/** Shared SQL for list and viewport reads; both use the fixed Warehouse alias w. */
function phoneSearchCondition(digits) {
    const pattern = `%${digits}%`;
    // Remove formatting on read so older/imported values also match. Preserve
    // separators such as commas and slashes between distinct contact numbers.
    return Prisma.sql`(
        regexp_replace(COALESCE(w."contactNumber", ''), '[[:space:]().+-]', '', 'g') LIKE ${pattern}
        OR regexp_replace(COALESCE(w."alt_phone_number", ''), '[[:space:]().+-]', '', 'g') LIKE ${pattern}
    )`;
}

/** Phone numbers must never be passed to Prisma as overflowing PostgreSQL Int IDs. */
function warehouseSearchId(term) {
    if (!/^\d+$/.test(term)) return null;
    const id = Number(term);
    return Number.isInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

module.exports = { phoneSearchDigits, phoneSearchCondition, warehouseSearchId };
