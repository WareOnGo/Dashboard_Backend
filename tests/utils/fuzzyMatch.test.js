const {
    normalize,
    editDistance,
    similarity,
    fuzzyScore,
    fuzzyMatches,
    DEFAULT_THRESHOLD,
} = require('../../src/utils/fuzzyMatch');

describe('fuzzyMatch', () => {
    describe('normalize', () => {
        it('lowercases and folds punctuation into single spaces', () => {
            expect(normalize('Bommasandra-Jigani  Link Rd.')).toBe('bommasandra jigani link rd');
        });

        it('handles null and undefined without throwing', () => {
            expect(normalize(null)).toBe('');
            expect(normalize(undefined)).toBe('');
        });
    });

    describe('editDistance', () => {
        it('is zero for identical strings', () => {
            expect(editDistance('peenya', 'peenya')).toBe(0);
        });

        it('counts single-character edits', () => {
            expect(editDistance('bomasandra', 'bommasandra')).toBe(1); // insertion
            expect(editDistance('whitfield', 'whitefield')).toBe(1);
            expect(editDistance('hosur', 'hosor')).toBe(1);           // substitution
        });

        it('falls back to length when one side is empty', () => {
            expect(editDistance('', 'hosur')).toBe(5);
            expect(editDistance('hosur', '')).toBe(5);
        });
    });

    describe('similarity', () => {
        it('is 1 for identical and 0 against empty', () => {
            expect(similarity('nelamangala', 'nelamangala')).toBe(1);
            expect(similarity('nelamangala', '')).toBe(0);
        });

        it('normalizes the distance by the longer string', () => {
            expect(similarity('abcd', 'abcx')).toBeCloseTo(0.75, 5);
        });
    });

    describe('fuzzyScore', () => {
        it('scores a substring hit as a perfect match', () => {
            // Typing a prefix must always land, however much name is left over.
            expect(fuzzyScore('bommasandra', 'Bommasandra Industrial Area')).toBe(1);
            expect(fuzzyScore('industrial', 'Bommasandra Industrial Area')).toBe(1);
        });

        it('is case- and punctuation-insensitive', () => {
            expect(fuzzyScore('LINK RD', 'Bommasandra-Jigani Link Rd.')).toBe(1);
        });

        it('tolerates a typo inside a longer name via word windows', () => {
            // Whole-string similarity here is ~0.4; the "bommasandra" window carries it.
            expect(fuzzyScore('bomasandra', 'Bommasandra Industrial Area'))
                .toBeGreaterThanOrEqual(DEFAULT_THRESHOLD);
        });

        it('matches an abbreviated multi-word term', () => {
            expect(fuzzyScore('peenya indl', 'Peenya Industrial Area'))
                .toBeGreaterThanOrEqual(DEFAULT_THRESHOLD);
        });

        it('rejects unrelated names', () => {
            expect(fuzzyScore('nelamangala', 'Peenya Industrial Area'))
                .toBeLessThan(DEFAULT_THRESHOLD);
            expect(fuzzyScore('hosur road', 'Whitefield')).toBeLessThan(DEFAULT_THRESHOLD);
        });

        it('does not fuzz very short terms into matching everything', () => {
            // "ab" vs "axb" scores 0.67 on raw similarity — above threshold — so short
            // terms are substring-only to keep a stray keystroke from matching all rows.
            expect(fuzzyScore('ab', 'axb')).toBe(0);
            expect(fuzzyScore('xy', 'Whitefield')).toBe(0);
            // A short term that IS a substring still matches.
            expect(fuzzyScore('wh', 'Whitefield')).toBe(1);
        });

        it('returns 0 when either side is empty', () => {
            expect(fuzzyScore('', 'Whitefield')).toBe(0);
            expect(fuzzyScore('Whitefield', '')).toBe(0);
        });
    });

    describe('fuzzyMatches', () => {
        it('applies the 60% default threshold', () => {
            expect(fuzzyMatches('whitfield', 'Whitefield')).toBe(true);
            expect(fuzzyMatches('nelamangala', 'Whitefield')).toBe(false);
        });

        it('honours an explicit threshold', () => {
            // 'hosur' vs 'hosor' scores 0.8: passes at 0.6, fails at 0.9.
            expect(fuzzyMatches('hosur', 'hosor', 0.6)).toBe(true);
            expect(fuzzyMatches('hosur', 'hosor', 0.9)).toBe(false);
        });
    });
});
