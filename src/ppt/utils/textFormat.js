/**
 * Cleans and title-cases free-text location strings from the database.
 * Collapses newlines/extra whitespace, strips trailing commas, and
 * capitalizes the first letter of each word (preserving existing
 * uppercase, e.g. acronyms like "MIDC").
 * @param {string} text - Raw location text (e.g. warehouse address)
 * @returns {string} Cleaned, title-cased string ('' if input is empty)
 */
function formatLocationText(text) {
    if (!text) return '';
    return text
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[\s,]+$/, '')
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

module.exports = { formatLocationText };
