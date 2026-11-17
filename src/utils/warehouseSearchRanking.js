// src/utils/warehouseSearchRanking.js
//
// Relevance matching and ranking for the dashboard search bar, per the
// "Search relevance & ranking" PRD (v6, 20 Oct 2026) and the decisions taken on
// it on 21 Oct 2026. Used for the warehouse list and map (WarehouseService) and
// the review queue (StagingService), so both screens rank the same way.
//
// Every match lands in a tier. Results sort by how many query words matched,
// then by tier, then newest first. Freshness never lifts a row across tiers.
//
// The warehouse table is a few thousand rows, so ranking a slim projection of it
// in memory is cheaper and far easier to keep correct than expressing per-word
// tiers, name-spelling rules and bounded edit distance in SQL. It is linear in
// rows (~40-100 ms for a typical query at 5k rows); revisit past ~10k.

const { phoneSearchDigits, warehouseSearchId } = require('./warehouseSearch');

// The tens digit names the PRD bucket (1 Exact, 2 Micromarket, 3 Address,
// 4 Partial, 5 City) for readers; code only ever compares tiers as numbers.
const TIER = Object.freeze({
    // 1 — Exact: number and name matches. ID outranks phone (21 Oct decision).
    ID: 10,
    PHONE: 11,
    NAME: 12,
    NAME_SPELLING: 13,
    // 2 — Micromarket: exact name before a longer name containing it.
    MICROMARKET_EXACT: 20,
    MICROMARKET_WORD: 21,
    // 3 — Address and pincode: whole word before part of a word.
    ADDRESS_WORD: 30,
    ADDRESS_SUBSTRING: 31,
    // 4 — Partial: spelling-tolerant location matches.
    MICROMARKET_TYPO: 40,
    ADDRESS_TYPO: 41,
    // 5 — City, then state.
    CITY: 50,
    CITY_TYPO: 51,
    STATE: 52,
});

/** Terms shorter than this only match whole words: a stray "in" must not hit "Industrial". */
const MIN_SUBSTRING_LENGTH = 3;

/**
 * Spelling tolerance for location names. Both bounds must hold: at most two
 * edits AND at least 75% similar. The PRD's probe found no extra micromarket hits
 * at 1–2 edits; the old 60% rule allowed four, which is how "Bommasandra"
 * reached "Cheemasandra".
 */
const TYPO_MAX_EDITS = 2;
const TYPO_MIN_SIMILARITY = 0.75;
const TYPO_MIN_LENGTH = 5;

/** The vowel rule only applies to names this long, or "Ram" would reach "Rama" and "Ramu". */
const VOWEL_RULE_MIN_LENGTH = 5;

/** Words that carry no search intent; dropped before counting word coverage. */
const STOPWORDS = new Set([
    'a', 'an', 'and', 'at', 'behind', 'for', 'godown', 'godowns', 'in', 'near', 'of',
    'opp', 'opposite', 'the', 'to', 'warehouse', 'warehouses',
]);

/** Spellings of one city. A row answers to every spelling of its city. */
const CITY_ALIAS_GROUPS = [['bangalore', 'bengaluru'], ['gurgaon', 'gurugram']];
const ALIAS_GROUP_OF = new Map(CITY_ALIAS_GROUPS.flatMap((group) => group.map((name) => [name, group])));

/**
 * A warehouse ID in a pasted list has at most this many digits, so a pasted
 * column of 6-digit pincodes or 10-digit phone numbers is searched number by
 * number instead. IDs are four digits today.
 */
const MAX_ID_DIGITS = 5;

/** Most IDs one pasted list may carry; bounds the id lookup and the response. */
const MAX_ID_LIST = 500;

/**
 * Row fields the matcher reads (see prepareRow). Models select these, plus
 * their id, recency field and anything table-specific, for the in-memory scan.
 */
const SEARCH_FIELDS = Object.freeze([
    'address', 'city', 'state', 'postalCode', 'contactPerson', 'ownerAltPoc',
    'ownerCompanyName', 'contactNumber', 'alt_phone_number',
]);
const ID_LIST_PART = new RegExp(`^\\d{1,${MAX_ID_DIGITS}}$`);

/**
 * Inside a longer query, a number is only a phone search when it is a whole
 * number: "Sector 9876" is an address, not a phone fragment.
 */
const MIN_EMBEDDED_PHONE_DIGITS = 10;

/** Upper bound on query words ranked, so a pasted paragraph cannot stall a request. */
const MAX_QUERY_WORDS = 10;

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

/**
 * Memoize a pure string function. Every search re-reads the same names, tags,
 * cities and addresses, so after the first query most normalization is a map
 * lookup. Cleared wholesale when full, which bounds memory without LRU upkeep.
 *
 * Sized well above the table: a row contributes about six distinct strings, so
 * 100k entries hold ~15k rows. A cache smaller than one full scan would clear
 * itself partway through every search and silently stop helping.
 * @param {(value: string) => *} fn
 * @param {number} [limit=100000]
 * @returns {(value: string) => *}
 */
function memoize(fn, limit = 100000) {
    const cache = new Map();
    return (value) => {
        let out = cache.get(value);
        if (out === undefined) {
            if (cache.size >= limit) cache.clear();
            out = fn(value);
            cache.set(value, out);
        }
        return out;
    };
}

/**
 * Lowercase and collapse every run of non-alphanumerics into one space. Text
 * outside printable ASCII is first compatibility-folded (NFKD, which also splits
 * accents off so "é" folds to "e") and stripped of invisible format characters;
 * plain ASCII skips that step.
 */
const normalizeCached = memoize((text) => {
    let out = text;
    if (/[^ -~]/.test(out)) {
        out = out.normalize('NFKD').replace(/\p{M}/gu, '').replace(/\p{Cf}/gu, '');
    }
    return out.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
});

/**
 * @param {*} value
 * @returns {string} normalized text
 */
function normalizeText(value) {
    return normalizeCached(String(value ?? ''));
}

/**
 * Spelling key for owner names (PRD v6 candidate rules): drop "h" after
 * b, c, d, g, j, k, p, t ("sh" is untouched), then collapse doubled letters.
 * The h-drop runs first so "Siddharth" and "Sidharth" both become "sidart".
 * @param {string} text - normalized text
 * @returns {string}
 */
function nameKey(text) {
    return text.replace(/([bcdgjkpt])h+/g, '$1').replace(/(.)\1+/g, '$1');
}

/**
 * True when `a` and `b` differ by exactly one inserted or deleted vowel.
 * Substitutions never count, which keeps Adil/Anil and Tarun/Varun apart.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function oneVowelApart(a, b) {
    if (Math.abs(a.length - b.length) !== 1) return false;
    const [longer, shorter] = a.length > b.length ? [a, b] : [b, a];
    let i = 0;
    while (i < shorter.length && longer[i] === shorter[i]) i += 1;
    return VOWELS.has(longer[i]) && longer.slice(i + 1) === shorter.slice(i);
}

/** Reused DP rows for boundedEditDistance; grown on demand, never shrunk. */
let prevRow = new Int32Array(64);
let currRow = new Int32Array(64);

/**
 * Levenshtein distance, giving up once it must exceed `max` (returns max + 1).
 *
 * Banded: only cells within `max` of the diagonal can stay within budget, so
 * each row fills at most 2·max+1 cells instead of the whole matrix.
 * @param {string} a
 * @param {string} b
 * @param {number} max
 * @returns {number}
 */
function boundedEditDistance(a, b, max) {
    if (a === b) return 0;
    const n = a.length;
    const m = b.length;
    const over = max + 1;
    if (Math.abs(n - m) > max) return over;
    if (prevRow.length <= m + 1) {
        prevRow = new Int32Array(m + 2);
        currRow = new Int32Array(m + 2);
    }
    let prev = prevRow;
    let curr = currRow;
    for (let j = 0; j <= m; j += 1) prev[j] = j <= max ? j : over;

    for (let i = 1; i <= n; i += 1) {
        const lo = Math.max(1, i - max);
        const hi = Math.min(m, i + max);
        curr[0] = i <= max ? i : over;
        if (lo > 1) curr[lo - 1] = over;
        let rowMin = lo === 1 ? curr[0] : over;
        const ac = a.charCodeAt(i - 1);
        for (let j = lo; j <= hi; j += 1) {
            let v = prev[j - 1] + (ac === b.charCodeAt(j - 1) ? 0 : 1);
            if (prev[j] + 1 < v) v = prev[j] + 1;
            if (curr[j - 1] + 1 < v) v = curr[j - 1] + 1;
            if (v > over) v = over;
            curr[j] = v;
            if (v < rowMin) rowMin = v;
        }
        if (hi < m) curr[hi + 1] = over;
        if (rowMin > max) return over;
        [prev, curr] = [curr, prev];
    }
    return Math.min(prev[m], over);
}

/**
 * True when `unit` is a likely misspelling of a run of `words` with as many
 * words as the unit, or one more or fewer (so "bomma sandra" still reaches
 * "Bommasandra"). Windows whose length alone rules them out are skipped before
 * any string is built, which keeps a full-table scan cheap.
 * @param {{text: string, wordCount: number}} unit - text at least TYPO_MIN_LENGTH long
 * @param {string[]} words - normalized words of the field
 * @returns {boolean}
 */
function typoMatches(unit, words) {
    const { text, wordCount } = unit;
    for (let size = Math.max(1, wordCount - 1); size <= Math.min(wordCount + 1, words.length); size += 1) {
        for (let start = 0; start + size <= words.length; start += 1) {
            let length = size - 1;
            for (let k = start; k < start + size; k += 1) length += words[k].length;
            if (Math.abs(length - text.length) > TYPO_MAX_EDITS) continue;
            const window = words.slice(start, start + size).join(' ');
            const distance = boundedEditDistance(text, window, TYPO_MAX_EDITS);
            if (distance <= TYPO_MAX_EDITS
                && 1 - distance / Math.max(text.length, window.length) >= TYPO_MIN_SIMILARITY) return true;
        }
    }
    return false;
}

/** `term` begins one of `text`'s words (or is one whole, when short). */
function startsWord(text, term) {
    if (!text) return false;
    return term.length < MIN_SUBSTRING_LENGTH
        ? ` ${text} `.includes(` ${term} `)
        : ` ${text}`.includes(` ${term}`);
}

const phoneDigitsOf = (value) => String(value ?? '').replace(/[\s().+-]/g, '');
const splitWords = (text) => (text ? text.split(' ') : []);

/**
 * Every spelling of a normalized city name ("bengaluru" → also "bangalore"), so
 * a prefix or a typo of either spelling finds rows stored under either.
 * @param {string} text
 * @returns {string[]}
 */
function cityVariants(text) {
    const words = splitWords(text);
    const group = words.map((word) => ALIAS_GROUP_OF.get(word)).find(Boolean);
    if (!group) return text ? [text] : [];
    return group.map((name) => words.map((word) => (group.includes(word) ? name : word)).join(' '));
}

/**
 * Name windows compared under the spelling rules: every single word, every run
 * of two or three words joined without spaces ("Sri Ram" → "sriram"), and the
 * whole name, which is the PRD's full-label comparison.
 * @param {string} text - normalized name
 * @returns {string[]} spelling keys
 */
const nameKeysOf = memoize((text) => {
    const words = splitWords(text);
    const keys = new Set([nameKey(words.join(''))]);
    for (let size = 1; size <= Math.min(3, words.length); size += 1) {
        for (let start = 0; start + size <= words.length; start += 1) {
            keys.add(nameKey(words.slice(start, start + size).join('')));
        }
    }
    return [...keys];
});

/**
 * One searchable unit of the query: a word, or the whole query.
 * @param {string} raw - as typed (phone formats need the original characters)
 * @param {boolean} standalone - true when the unit is the entire query; only
 *   then may a number be a warehouse ID or a phone fragment
 * @returns {Object}
 */
function makeUnit(raw, standalone) {
    const text = normalizeText(raw);
    const joined = text.replace(/ /g, '');
    const numeric = /^\d+$/.test(joined);
    const digits = phoneSearchDigits(raw.trim());
    return {
        text,
        joined,
        key: nameKey(joined),
        numeric,
        wordCount: splitWords(text).length,
        id: standalone ? warehouseSearchId(raw.trim()) : null,
        phoneDigits: digits && (standalone || digits.length >= MIN_EMBEDDED_PHONE_DIGITS) ? digits : null,
        long: text.length >= MIN_SUBSTRING_LENGTH,
        typoable: !numeric && text.length >= TYPO_MIN_LENGTH,
    };
}

/** A phone number in any format, or digits and spaces: one number, never words. */
const isNumberPiece = (piece) => phoneSearchDigits(piece) !== null || /^[\d\s]+$/.test(piece);

/**
 * Split a query into the units whose coverage is counted.
 *
 * A number-only query (ID, phone in any format, pincode) stays one unit, so
 * "98450 12345" is one phone number rather than two fragments; a comma- or
 * semicolon-separated list of numbers ("9845012345, 9845012346") is one such
 * unit per number. Otherwise each non-stopword word is a unit, and the whole
 * query is also tried as one unit covering all of them, which lets "Hosur Road"
 * match the tag exactly and "sri ram" match "Sriram".
 * @param {string} term
 * @returns {{slots: Array, whole: Object|null}|null} null for an empty query
 */
function parseQuery(term) {
    const raw = String(term ?? '').trim();
    const whole = makeUnit(raw, true);
    if (!whole.text) return null;
    const pieces = raw.split(/[,;]/).map((piece) => piece.trim()).filter(Boolean);
    if (pieces.every(isNumberPiece)) {
        return { slots: pieces.slice(0, MAX_QUERY_WORDS).map((piece) => makeUnit(piece, true)), whole: null };
    }

    const words = whole.text.split(' ').filter((w) => !STOPWORDS.has(w)).slice(0, MAX_QUERY_WORDS);
    if (words.length === 0) return { slots: [whole], whole: null };
    const slots = words.map((word) => makeUnit(word, words.length === 1));
    const coversMore = slots.length > 1 || slots[0].text !== whole.text;
    return { slots, whole: coversMore ? whole : null };
}

/**
 * A row's searchable fields, normalized once so every query unit reuses them.
 * @param {Object} row
 * @returns {Object}
 */
function prepareRow(row) {
    const names = [row.contactPerson, row.ownerAltPoc, row.ownerCompanyName].map(normalizeText).filter(Boolean);
    const micromarkets = (Array.isArray(row.micromarket) ? row.micromarket : [])
        .flatMap((tag) => String(tag ?? '').split('/'))
        .map(normalizeText).filter(Boolean);
    const address = normalizeText(row.address);
    return {
        // A staged row also answers to the warehouse it edits.
        ids: [row.id, row.warehouseId].filter((id) => id != null).map(Number),
        phones: [row.contactNumber, row.alt_phone_number].map(phoneDigitsOf).filter(Boolean),
        names,
        nameKeys: names.flatMap(nameKeysOf),
        micromarkets,
        micromarketWords: micromarkets.map(splitWords),
        address,
        addressWords: splitWords(address),
        postalCode: phoneDigitsOf(row.postalCode),
        cities: cityVariants(normalizeText(row.city)),
        state: normalizeText(row.state),
    };
}

/**
 * The best (lowest) tier at which one query unit matches a prepared row, or
 * Infinity. Checks run best-first and stop at the first hit.
 * @param {Object} unit - from makeUnit
 * @param {Object} row - from prepareRow
 * @returns {number}
 */
function unitTier(unit, row) {
    const { text } = unit;

    if (unit.id !== null && row.ids.includes(unit.id)) return TIER.ID;
    if (unit.phoneDigits && row.phones.some((phone) => phone.includes(unit.phoneDigits))) return TIER.PHONE;

    if (row.names.some((name) => startsWord(name, text))) return TIER.NAME;
    if (!unit.numeric && unit.long && row.nameKeys.some((key) => key === unit.key
        || (Math.min(key.length, unit.key.length) >= VOWEL_RULE_MIN_LENGTH && oneVowelApart(key, unit.key)))) {
        return TIER.NAME_SPELLING;
    }

    if (row.micromarkets.includes(text)) return TIER.MICROMARKET_EXACT;
    if (row.micromarkets.some((tag) => startsWord(tag, text))) return TIER.MICROMARKET_WORD;

    if (` ${row.address} `.includes(` ${text} `)) return TIER.ADDRESS_WORD;
    if (unit.numeric && row.postalCode && unit.joined === row.postalCode) return TIER.ADDRESS_WORD;
    if (unit.long && row.address.includes(text)) return TIER.ADDRESS_SUBSTRING;
    // A partial pincode is its leading digits ("56009" for 560099).
    if (unit.numeric && unit.joined.length >= 4 && row.postalCode.startsWith(unit.joined)) return TIER.ADDRESS_SUBSTRING;

    if (unit.typoable && row.micromarketWords.some((words) => typoMatches(unit, words))) return TIER.MICROMARKET_TYPO;
    if (unit.typoable && typoMatches(unit, row.addressWords)) return TIER.ADDRESS_TYPO;

    if (row.cities.some((city) => startsWord(city, text))) return TIER.CITY;
    if (unit.typoable && row.cities.some((city) => typoMatches(unit, splitWords(city)))) return TIER.CITY_TYPO;
    if (startsWord(row.state, text)) return TIER.STATE;
    return Infinity;
}

/** Lexicographic comparison of two equal-length ascending tier lists. */
function compareTiers(a, b) {
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
}

const timeOf = (value) => {
    const t = value == null ? NaN : new Date(value).getTime();
    return Number.isNaN(t) ? -Infinity : t;
};

/**
 * Rank rows against a free-text query. Rows matching no query word are dropped.
 *
 * Order: more query words matched first, then the best tiers (compared word by
 * word, best first), then newest first, then highest numeric id. Ties beyond
 * that keep the input order (the sort is stable).
 *
 * @param {string} term - the search text
 * @param {Array<Object>} rows - rows carrying id and the searchable fields
 * @param {Object} [options]
 * @param {(row: Object) => *} [options.recency] - the row's timestamp for
 *   newest-first ordering; defaults to `createdAt`
 * @returns {Array<{row: Object, tiers: number[], matched: number}>} ranked matches
 */
function rankWarehouses(term, rows, { recency = (row) => row.createdAt } = {}) {
    const query = parseQuery(term);
    if (!query) return [];

    const ranked = [];
    for (const row of rows) {
        const prepared = prepareRow(row);
        const wholeTier = query.whole ? unitTier(query.whole, prepared) : Infinity;
        const tiers = query.slots
            .map((unit) => Math.min(unitTier(unit, prepared), wholeTier))
            .sort((a, b) => a - b);
        const matched = tiers.filter(Number.isFinite).length;
        if (matched > 0) ranked.push({ row, tiers, matched, time: timeOf(recency(row)) });
    }

    return ranked
        .sort((a, b) => (b.matched - a.matched)
            || compareTiers(a.tiers, b.tiers)
            || (b.time - a.time)
            || ((Number(b.row.id) || 0) - (Number(a.row.id) || 0)))
        .map(({ row, tiers, matched }) => ({ row, tiers, matched }));
}

/**
 * Read a pasted list of warehouse IDs ("412, 87, 1503", one per line, or a
 * tab-separated spreadsheet row).
 *
 * Needs at least one comma, semicolon, tab or line break, and nothing but
 * numbers of up to MAX_ID_DIGITS digits between them, so a single number keeps
 * its ID-or-phone meaning and a list of pincodes or phones is searched number
 * by number (see parseQuery).
 *
 * @param {string} term
 * @returns {{ids: number[], entries: Array<{text: string, id: (number|null)}>}|null}
 *   `entries` is every distinct pasted value in pasted order (id null when it
 *   cannot be a warehouse id, e.g. "0"); `ids` the usable ids among them. Null
 *   when the text is not an ID list.
 */
function parseIdList(term) {
    const text = String(term ?? '');
    if (!/[,;\n\r\t]/.test(text)) return null;
    const parts = text.split(/[,;\n\r\t]+/).map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0 || !parts.every((part) => ID_LIST_PART.test(part))) return null;

    const entries = [];
    const seen = new Set();
    for (const part of parts) {
        const id = warehouseSearchId(part);
        const key = id ?? part;
        if (!seen.has(key)) {
            seen.add(key);
            entries.push({ text: part, id });
        }
    }
    return { ids: entries.map((entry) => entry.id).filter((id) => id !== null), entries };
}

module.exports = {
    TIER,
    MAX_ID_LIST,
    SEARCH_FIELDS,
    normalizeText,
    nameKey,
    oneVowelApart,
    boundedEditDistance,
    parseQuery,
    rankWarehouses,
    parseIdList,
};
