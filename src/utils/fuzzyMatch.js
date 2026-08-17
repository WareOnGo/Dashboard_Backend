// src/utils/fuzzyMatch.js
//
// Small, dependency-free approximate string matching, used to make the dashboard
// search bar tolerant of spelling mistakes in micro-market names ("bomasandra"
// should still find "Bommasandra Industrial Area").
//
// Kept deliberately simple: the candidate set is a closed vocabulary of a few
// hundred short polygon names, so an O(n·m) edit distance per candidate is
// cheap and there is no need for a trigram index or an external library.
//
// NOTE: mirrored in Frontend_Repository/src/utils/fuzzyMatch.js, which powers the
// client-side filter (review queue / already-loaded rows). Keep the two in sync —
// diverging thresholds would make the same query return different sets depending
// on whether it was answered by the server or by the client filter.

/** Default similarity a candidate must reach to count as a match (60%). */
const DEFAULT_THRESHOLD = 0.6;

/**
 * Terms shorter than this are matched by substring only, never fuzzily. At 60%,
 * a two-character term is within tolerance of almost anything ("ab" vs "abc"
 * scores 0.67), which would turn a stray keystroke into a match-everything query.
 */
const MIN_FUZZY_TERM_LENGTH = 3;

/**
 * Lowercase, fold every run of non-alphanumerics into a single space, and trim.
 * Makes "Bommasandra-Jigani Link Rd." and "bommasandra jigani link rd" compare equal.
 * @param {string} s
 * @returns {string}
 */
function normalize(s) {
    return String(s ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/**
 * Levenshtein edit distance between two strings, two-row DP (O(min(a,b)) space).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    let prev = new Array(b.length + 1);
    let curr = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j += 1) prev[j] = j;

    for (let i = 1; i <= a.length; i += 1) {
        curr[0] = i;
        const ac = a.charCodeAt(i - 1);
        for (let j = 1; j <= b.length; j += 1) {
            const cost = ac === b.charCodeAt(j - 1) ? 0 : 1;
            curr[j] = Math.min(
                prev[j] + 1,      // deletion
                curr[j - 1] + 1,  // insertion
                prev[j - 1] + cost // substitution
            );
        }
        [prev, curr] = [curr, prev];
    }
    return prev[b.length];
}

/**
 * Edit-distance similarity in [0, 1]: 1 is identical, 0 shares nothing.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function similarity(a, b) {
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    const longest = Math.max(a.length, b.length);
    return 1 - editDistance(a, b) / longest;
}

/**
 * Every contiguous run of 1..maxWords words in `text`, longest first.
 *
 * Scoring a short term against a long name whole-string is unfairly harsh —
 * "peenya indl" vs "peenya industrial area" scores 0.52 on the full string but
 * 0.65 against the "peenya industrial" window. Comparing against windows lets a
 * term match the part of the name it was aimed at.
 * @param {string} text - normalized text
 * @param {number} maxWords
 * @returns {string[]}
 */
function wordWindows(text, maxWords) {
    const words = text.split(' ').filter(Boolean);
    const out = [];
    for (let size = Math.min(maxWords, words.length); size >= 1; size -= 1) {
        for (let start = 0; start + size <= words.length; start += 1) {
            out.push(words.slice(start, start + size).join(' '));
        }
    }
    return out;
}

/**
 * How well `term` matches `candidate`, in [0, 1].
 *
 * A candidate that literally contains the term scores 1 — typing a prefix of a
 * name must always hit it, regardless of how much name is left over. Otherwise
 * the score is the best edit-distance similarity across the whole candidate and
 * its word windows.
 *
 * @param {string} term - the user's search text
 * @param {string} candidate - the value being searched
 * @returns {number}
 */
function fuzzyScore(term, candidate) {
    const needle = normalize(term);
    const hay = normalize(candidate);
    if (!needle || !hay) return 0;
    if (hay.includes(needle)) return 1;
    if (needle.length < MIN_FUZZY_TERM_LENGTH) return 0;

    const termWords = needle.split(' ').filter(Boolean).length;
    let best = similarity(needle, hay);
    // One extra word of slack, so an abbreviated term ("peenya indl") can still
    // reach across a slightly longer window than it has words of its own.
    for (const window of wordWindows(hay, termWords + 1)) {
        if (best === 1) break;
        best = Math.max(best, similarity(needle, window));
    }
    return best;
}

/**
 * True when `term` matches `candidate` at or above `threshold`.
 * @param {string} term
 * @param {string} candidate
 * @param {number} [threshold=DEFAULT_THRESHOLD]
 * @returns {boolean}
 */
function fuzzyMatches(term, candidate, threshold = DEFAULT_THRESHOLD) {
    return fuzzyScore(term, candidate) >= threshold;
}

module.exports = {
    DEFAULT_THRESHOLD,
    MIN_FUZZY_TERM_LENGTH,
    normalize,
    editDistance,
    similarity,
    fuzzyScore,
    fuzzyMatches,
};
