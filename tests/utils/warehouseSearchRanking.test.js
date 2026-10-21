const {
    TIER, rankWarehouses, parseIdList, parseQuery, nameKey, oneVowelApart, boundedEditDistance,
} = require('../../src/utils/warehouseSearchRanking');

// Synthetic rows only. Defaults keep every field present so each test states
// just the fields it is about.
let nextId = 1;
const row = (fields = {}) => ({
    id: nextId++, createdAt: new Date('2026-01-01'), address: '', city: '', state: '',
    postalCode: null, contactPerson: '', ownerAltPoc: null, ownerCompanyName: null,
    contactNumber: '', alt_phone_number: null, micromarket: [], ...fields,
});
const ids = (term, rows) => rankWarehouses(term, rows).map((match) => match.row.id);
const tierOf = (term, fields) => rankWarehouses(term, [row(fields)])[0]?.tiers[0] ?? null;
/** Weakest word's tier when every query word matched, else null. */
const fullTier = (term, fields) => {
    const match = rankWarehouses(term, [row(fields)])[0];
    return match && match.matched === match.tiers.length ? match.tiers[match.tiers.length - 1] : null;
};

describe('owner-name spelling rules (PRD v6 acceptance table)', () => {
    test.each([
        ['Likhith', 'Likith'], ['Adhil', 'Adil'], ['Soumya', 'Somya'], ['Jagadish', 'Jagdish'],
        ['Chandra Shekhar', 'Chandrashekhar'], ['Srinivas', 'Srinivasa'], ['Umesh Ready', 'Umesh Reddy'],
    ])('%s finds %s, and the other way round, inside the Exact bucket', (a, b) => {
        // Some pairs also match literally (Srinivas starts Srinivasa), which is
        // a better tier; either way every word matches within bucket 1.
        expect(fullTier(a, { contactPerson: b })).toBeLessThanOrEqual(TIER.NAME_SPELLING);
        expect(fullTier(b, { contactPerson: a })).toBeLessThanOrEqual(TIER.NAME_SPELLING);
    });

    test('Likhith and Likith match through the spelling rule, not literally', () => {
        expect(tierOf('Likhith', { contactPerson: 'Likith' })).toBe(TIER.NAME_SPELLING);
        expect(fullTier('Umesh Ready', { contactPerson: 'Umesh Reddy' })).toBe(TIER.NAME_SPELLING);
    });

    test.each([['Adil', 'Anil'], ['Tarun', 'Varun'], ['Mohit', 'Rohit']])(
        'consonant substitution keeps %s and %s apart', (a, b) => {
            expect(tierOf(a, { contactPerson: b })).toBeNull();
        },
    );

    test('the vowel rule needs five letters, so Ram does not reach Rama or Ramu', () => {
        expect(oneVowelApart('ram', 'rama')).toBe(true);
        expect(tierOf('Rama', { contactPerson: 'Ram' })).toBeNull();
        expect(tierOf('Ramu', { contactPerson: 'Ram' })).toBeNull();
    });

    test('no vowel substitution: Mohammed and Mohammad stay distinct', () => {
        expect(tierOf('Mohammed', { contactPerson: 'Mohammad' })).toBeNull();
    });

    test('h is dropped before doubled letters collapse', () => {
        expect(nameKey('siddharth')).toBe('sidart');
        expect(nameKey('chhaya')).toBe(nameKey('chaya'));
        expect(nameKey('shekhar')).toBe('shekar');
    });

    test('rules apply to the alternate POC and the company name too', () => {
        expect(tierOf('Likhith', { ownerAltPoc: 'Likith' })).toBe(TIER.NAME_SPELLING);
        expect(tierOf('Srinivasa', { ownerCompanyName: 'Srinivas Logistics' })).toBe(TIER.NAME_SPELLING);
    });
});

describe('name matching starts at a word', () => {
    test('"Ram" finds Ram Kumar, Ramesh and Sri Ram, but not Sriram or Balram', () => {
        const rows = ['Ram Kumar', 'Ramesh', 'Sri Ram', 'Sriram', 'Balram'].map((contactPerson) => row({ contactPerson }));
        const names = rankWarehouses('Ram', rows).map((match) => match.row.contactPerson);
        expect(names.sort()).toEqual(['Ram Kumar', 'Ramesh', 'Sri Ram']);
    });

    test('spaces are ignored across the whole name: "sri ram" and "sriram" find each other', () => {
        expect(fullTier('sri ram', { contactPerson: 'Sriram' })).toBe(TIER.NAME_SPELLING);
        expect(fullTier('sriram', { contactPerson: 'Sri Ram' })).toBe(TIER.NAME_SPELLING);
    });

    test('a dropped initial still matches the rest of the name', () => {
        expect(tierOf('Siddappa', { contactPerson: 'A Siddappa' })).toBe(TIER.NAME);
        expect(tierOf('A Siddappa', { contactPerson: 'A Siddappa' })).toBe(TIER.NAME);
    });
});

describe('micromarket matching', () => {
    test('"Bommasandra" no longer reaches Cheemasandra (four edits)', () => {
        const bomma = row({ micromarket: ['Bommasandra'] });
        const cheema = row({ micromarket: ['Cheemasandra'] });
        expect(ids('Bommasandra', [cheema, bomma])).toEqual([bomma.id]);
        expect(ids('bomasandra', [cheema, bomma])).toEqual([bomma.id]);
        expect(tierOf('bomasandra', { micromarket: ['Bommasandra'] })).toBe(TIER.MICROMARKET_TYPO);
    });

    test('a two-edit neighbour is still found, but ranks below the exact name', () => {
        const sarjapura = row({ micromarket: ['Sarjapura'], createdAt: new Date('2026-09-01') });
        const narsapura = row({ micromarket: ['Narsapura'] });
        expect(ids('narsapura', [sarjapura, narsapura])).toEqual([narsapura.id, sarjapura.id]);
    });

    test('exact name before a longer name containing it ("ABC" before "ABCD")', () => {
        const tBegur = row({ micromarket: ['T Begur'], createdAt: new Date('2026-09-01') });
        const begur = row({ micromarket: ['Begur'] });
        expect(ids('Begur', [tBegur, begur])).toEqual([begur.id, tBegur.id]);
    });

    test('multi-word tags match exactly when the whole query is the tag', () => {
        expect(tierOf('hosur road', { micromarket: ['Hosur Road'] })).toBe(TIER.MICROMARKET_EXACT);
    });

    test('each alternate of a slashed tag matches on its own', () => {
        expect(tierOf('Kalyan', { micromarket: ['Bhiwandi/Kalyan'] })).toBe(TIER.MICROMARKET_EXACT);
    });
});

describe('bucket order', () => {
    test('micromarket, then address word, then address substring, then city', () => {
        const city = row({ city: 'Peenya' });
        const substring = row({ address: 'Plot 4, Peenyagate' });
        const word = row({ address: 'Plot 4, Peenya 2nd Stage' });
        const tagged = row({ micromarket: ['Peenya'] });
        expect(ids('peenya', [city, substring, word, tagged])).toEqual([tagged.id, word.id, substring.id, city.id]);
    });

    test('a link-road address ranks right after the exact micromarket', () => {
        const linkRoad = row({ micromarket: ['Jigani'], address: 'Bommasandra-Jigani Link Road' });
        const tagged = row({ micromarket: ['Bommasandra'] });
        expect(ids('Bommasandra', [linkRoad, tagged])).toEqual([tagged.id, linkRoad.id]);
    });

    test('address typos match below every literal location match', () => {
        expect(tierOf('whitfield', { address: 'Whitefield Main Road' })).toBe(TIER.ADDRESS_TYPO);
        expect(tierOf('bommasndra', { address: 'Near Bommasandra' })).toBe(TIER.ADDRESS_TYPO);
        expect(fullTier('bomma sandra', { address: 'Near Bommasandra' })).toBe(TIER.ADDRESS_SUBSTRING);
    });

    test('warehouse ID outranks a phone number containing the same digits', () => {
        const phone = row({ contactNumber: '9000015030' });
        const target = row({ id: 1503 });
        expect(ids('1503', [phone, target])).toEqual([1503, phone.id]);
    });

    test('a pincode matches typed with a space, or by its leading digits', () => {
        expect(tierOf('560 099', { postalCode: '560099' })).toBe(TIER.ADDRESS_WORD);
        expect(tierOf('56009', { postalCode: '560099' })).toBe(TIER.ADDRESS_SUBSTRING);
        expect(tierOf('5600', { postalCode: '560099' })).toBe(TIER.ADDRESS_SUBSTRING);
        expect(tierOf('600', { postalCode: '560099' })).toBeNull();
    });

    test('pincode ranks with the address, below a phone fragment', () => {
        const pincode = row({ postalCode: '560 099' });
        const phone = row({ contactNumber: '9560099000' });
        expect(ids('560099', [pincode, phone])).toEqual([phone.id, pincode.id]);
        expect(tierOf('560099', { postalCode: '560099' })).toBe(TIER.ADDRESS_WORD);
    });

    test('an owner name outranks an exact micromarket', () => {
        const tagged = row({ micromarket: ['Rampura'] });
        const owner = row({ contactPerson: 'Rampura Traders' });
        expect(ids('rampura', [tagged, owner])).toEqual([owner.id, tagged.id]);
    });

    test('warehouse type and owner type are filters, not search fields', () => {
        expect(tierOf('PEB', { warehouseType: 'PEB' })).toBeNull();
        expect(tierOf('Broker', { warehouseOwnerType: 'Broker' })).toBeNull();
    });

    test.each(['Bangalore', 'Bengaluru'])('either spelling, prefix or typo finds a row stored as %s', (city) => {
        for (const query of ['bangalore', 'bengaluru', 'bang', 'beng']) expect(tierOf(query, { city })).toBe(TIER.CITY);
        for (const query of ['banglore', 'bengalore', 'bengaluur']) expect(tierOf(query, { city })).toBe(TIER.CITY_TYPO);
    });

    test('Gurgaon and Gurugram find each other', () => {
        expect(tierOf('gurgaon', { city: 'Gurugram' })).toBe(TIER.CITY);
        expect(tierOf('gurugram', { city: 'Gurgaon' })).toBe(TIER.CITY);
    });

    test('state is the last bucket', () => {
        expect(tierOf('karnataka', { state: 'Karnataka' })).toBe(TIER.STATE);
    });
});

describe('mixed queries', () => {
    test('"Mukesh rampura": both words first, then the better single-word match', () => {
        const both = row({ contactPerson: 'Mukesh Patel', micromarket: ['Rampura'] });
        const placeOnly = row({ micromarket: ['Rampura'], createdAt: new Date('2026-10-01') });
        const ownerOnly = row({ contactPerson: 'Mukesh Kumar' });
        expect(ids('Mukesh rampura', [placeOnly, ownerOnly, both])).toEqual([both.id, ownerOnly.id, placeOnly.id]);
    });

    test('word coverage beats recency', () => {
        const old = row({ contactPerson: 'Mukesh', address: 'Rampura Main Road', createdAt: new Date('2020-01-01') });
        const fresh = row({ contactPerson: 'Mukesh', createdAt: new Date('2026-10-01') });
        expect(ids('mukesh rampura', [fresh, old])).toEqual([old.id, fresh.id]);
    });

    test('stopwords do not count as words to cover', () => {
        expect(parseQuery('warehouse in peenya').slots.map((unit) => unit.text)).toEqual(['peenya']);
        expect(tierOf('warehouse in peenya', { micromarket: ['Peenya'] })).toBe(TIER.MICROMARKET_EXACT);
    });

    test('a comma-separated list of phones or pincodes searches each number', () => {
        const phones = [row({ contactNumber: '9845012345' }), row({ contactNumber: '9845012346' }), row({ contactNumber: '9000000000' })];
        expect(ids('9845012345, 9845012346', phones).sort()).toEqual([phones[0].id, phones[1].id].sort());
        const pins = [row({ postalCode: '560058' }), row({ postalCode: '560099' })];
        expect(ids('560058; 560099', pins).sort()).toEqual(pins.map((p) => p.id).sort());
    });

    test('a phone number with spaces is one number, not two fragments', () => {
        const owner = row({ contactNumber: '+91 98450 12345' });
        const fragment = row({ contactNumber: '9000012345' });
        expect(ids('98450 12345', [owner, fragment])).toEqual([owner.id]);
    });

    test('a number inside a longer query is not an ID or a phone fragment', () => {
        expect(tierOf('Plot 42 Peenya', { id: 42 })).toBeNull();
        expect(tierOf('Sector 9876', { contactNumber: '9000098765' })).toBeNull();
        expect(tierOf('Sector 9876', { address: 'Sector 9876, Gurugram' })).toBe(TIER.ADDRESS_WORD);
    });

    test('a complete phone number still matches inside a longer query', () => {
        const [match] = rankWarehouses('Mukesh 9845012345', [row({ contactPerson: 'Mukesh', contactNumber: '+91 98450 12345' })]);
        expect(match.tiers).toEqual([TIER.PHONE, TIER.NAME]);
    });

    test('short words only match whole words', () => {
        expect(tierOf('pe', { address: 'Peenya Industrial Area' })).toBeNull();
        expect(tierOf('hsr', { micromarket: ['HSR'] })).toBe(TIER.MICROMARKET_EXACT);
    });
});

describe('recency inside a tier', () => {
    test('newest first, then highest id; rows without a date go last', () => {
        const undated = row({ micromarket: ['Peenya'], createdAt: null });
        const older = row({ micromarket: ['Peenya'], createdAt: new Date('2025-01-01') });
        const newer = row({ micromarket: ['Peenya'], createdAt: new Date('2026-05-01') });
        expect(ids('peenya', [undated, older, newer])).toEqual([newer.id, older.id, undated.id]);
    });
});

describe('rows from other tables', () => {
    test('a staged row answers to the warehouse id it edits', () => {
        const staged = { ...row(), id: 'a1b2c3', warehouseId: 1503 };
        expect(rankWarehouses('1503', [staged])[0]?.tiers).toEqual([TIER.ID]);
    });

    test('the recency field is configurable, and non-numeric ids keep input order', () => {
        const older = { ...row({ micromarket: ['Peenya'] }), id: 'x', createdAt: undefined, submittedAt: '2026-01-01' };
        const newer = { ...row({ micromarket: ['Peenya'] }), id: 'y', createdAt: undefined, submittedAt: '2026-05-01' };
        const order = (options) => rankWarehouses('peenya', [older, newer], options).map((m) => m.row.id);
        expect(order({ recency: (r) => r.submittedAt })).toEqual(['y', 'x']);
        expect(order()).toEqual(['x', 'y']);
    });
});

describe('parseIdList', () => {
    test.each([
        ['412, 87, 1503', [412, 87, 1503]],
        ['412\n87\n1503', [412, 87, 1503]],
        ['412;87', [412, 87]],
        ['412, 87, 412', [412, 87]],
        ['412,', [412]],
        ['412\t87\t1503', [412, 87, 1503]],
        ['412\r\n87\r\n', [412, 87]],
    ])('reads %j in pasted order', (term, expected) => {
        expect(parseIdList(term).ids).toEqual(expected);
    });

    test.each([
        '412', '98450 12345', '98450 12345, 98450 54321', 'Peenya, Bommasandra', '', null,
        // Pincodes and phones are longer than any warehouse ID, so a pasted
        // column of them is searched number by number instead of reporting
        // "not found".
        '560099, 560058', '9845012345\n9845012346', '412, 560099',
    ])('%j is not an ID list', (term) => {
        expect(parseIdList(term)).toBeNull();
    });

    test('keeps every distinct pasted value in pasted order, flagging ones that cannot be IDs', () => {
        expect(parseIdList('5, 0, 12, 5')).toEqual({
            ids: [5, 12],
            entries: [{ text: '5', id: 5 }, { text: '0', id: null }, { text: '12', id: 12 }],
        });
    });
});

describe('boundedEditDistance', () => {
    const levenshtein = (a, b) => {
        let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
        for (let i = 1; i <= a.length; i += 1) {
            const curr = [i];
            for (let j = 1; j <= b.length; j += 1) {
                curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            }
            prev = curr;
        }
        return prev[b.length];
    };

    test('agrees with plain Levenshtein, capped at max + 1', () => {
        // Deterministic pseudo-random strings over a small alphabet, so near
        // matches are common; long-then-short pairs also exercise buffer reuse.
        let seed = 7;
        const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
        const word = () => Array.from({ length: Math.floor(random() * 14) }, () => 'abcd'[Math.floor(random() * 4)]).join('');
        for (let k = 0; k < 20000; k += 1) {
            const a = word();
            const b = word();
            const max = Math.floor(random() * 4);
            expect(boundedEditDistance(a, b, max)).toBe(Math.min(levenshtein(a, b), max + 1));
        }
    });

    test('stops early past the bound', () => {
        expect(boundedEditDistance('bommasandra', 'cheemasandra', 2)).toBe(3);
        expect(boundedEditDistance('bomasandra', 'bommasandra', 2)).toBe(1);
    });
});
