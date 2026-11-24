// Canonical pure policy. Generate the client copies with scripts/syncPptFormPolicy.cjs.
// No database constraints or ID cutoff.
const PPT_FORM_FIELDS = [
    { key: 'warehouseType', label: 'Warehouse Type' },
    { key: 'address', label: 'Address' },
    { key: 'googleLocation', label: 'Google Location URL' },
    { key: 'landType', label: 'Land Type', nested: true },
    { key: 'totalSpaceSqft', label: 'Offered Area', kind: 'areas' },
    { key: 'ratePerSqft', label: 'Rate per sq ft' },
    { key: 'clearHeightFt', label: 'Clear Height', kind: 'length' },
    { key: 'flooringType', label: 'Flooring Type', choices: ['Tiles', 'Conventional Concrete', 'VDF', 'FM2', 'Kota Stone', 'Others', 'Not Known'] },
    { key: 'floorStrengthPerSqm', label: 'Floor Strength', kind: 'load' },
    { key: 'numberOfDocks', label: 'Number of Docks', kind: 'count' },
    { key: 'plinthHeightFt', label: 'Plinth Height', kind: 'length', zero: true },
    { key: 'canopyType', label: 'Canopy Type', choices: ['Running', 'Shutter', 'None'] },
    { key: 'ventilationType', label: 'Ventilation Type', kind: 'ventilation' },
    { key: 'powerKva', label: 'Power', nested: true, kind: 'power', zero: true },
    { key: 'washroom_count', label: 'Washroom Count', kind: 'washrooms' },
    { key: 'fireNocAvailable', label: 'Fire NOC Available', nested: true, kind: 'boolean' },
    { key: 'fireSafetyMeasures', label: 'Fire Safety Measures', nested: true },
];
const HANDOVER_FIELDS = ['handoverType', 'handoverDate', 'handoverLeadValue', 'handoverLeadUnit'];
const HANDOVER_LABELS = ['Handover type', 'Handover date', 'Handover lead time', 'Handover lead-time unit'];
const flatFormValues = value => ({ ...value, ...(value?.WarehouseData || value?.warehouseData || {}) });
const isBlankAnswer = value => value == null || typeof value === 'string' && /^(?:\s*|\s*n\/?a\s*)$/i.test(value)
    || Array.isArray(value) && value.length === 0;
const sameAnswer = (a, b) => isBlankAnswer(a) && isBlankAnswer(b)
    || JSON.stringify(typeof a === 'string' ? a.trim() : a) === JSON.stringify(typeof b === 'string' ? b.trim() : b);

function validCalendarDate(value) {
    const text = value instanceof Date ? (Number.isNaN(value.getTime()) ? '' : value.toISOString()) : value;
    if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.test(text) || text.startsWith('0000-')) return false;
    const date = new Date(text);
    const calendar = new Date(`${text.slice(0, 10)}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && !Number.isNaN(calendar.getTime()) && calendar.toISOString().slice(0, 10) === text.slice(0, 10);
}

function fieldAnswerError(field, value) {
    if (field.kind === 'boolean') return typeof value === 'boolean' ? null : 'Select Yes or No.';
    if (field.kind === 'areas') return Array.isArray(value) && value.length > 0 && value.every(n => Number.isInteger(n) && n > 0)
        ? null : 'Enter positive whole-number offered areas.';
    if (typeof value !== 'string') return 'Enter a valid answer.';
    const text = value.trim();
    if (field.choices) return field.choices.includes(text) ? null : 'Select an available option.';
    if (field.kind === 'count') return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? null : 'Enter a whole number of zero or more.';
    if (['length', 'load', 'power'].includes(field.kind)) {
        if (field.kind === 'power' && /^as\s+per\s+requirement$/i.test(text)) return null;
        if (field.kind === 'load' && /^to\s+be\s+confirmed$/i.test(text)) return null;
        const match = /^(\d+(?:\.\d+)?|\.\d+)\s*(.*?)$/.exec(text);
        const units = { length: ['', 'feet', 'ft', 'metres', 'm'], load: ['', 'tonnes/sq m'], power: ['', 'kva', 'hp'] };
        return match && Number.isFinite(Number(match[1])) && (field.zero ? Number(match[1]) >= 0 : Number(match[1]) > 0)
            && units[field.kind].includes(match[2].toLowerCase()) ? null : 'Enter a valid measurement and unit.';
    }
    if (field.kind === 'ventilation') {
        const choices = text.split(',').map(v => v.trim());
        const allowed = ['Ridge', 'Turbo', 'Side Louvres', 'Window', 'None', 'Not Known'];
        return choices.every(v => allowed.includes(v)) && new Set(choices).size === choices.length
            && (choices.length === 1 || !choices.some(v => ['None', 'Not Known'].includes(v))) ? null : 'Select valid ventilation options.';
    }
    if (field.kind === 'washrooms') {
        const parts = text.split(';').map(v => /^(Male|Female):\s*(\d+)$/i.exec(v.trim()));
        return parts.every(v => v && Number.isSafeInteger(Number(v[2])))
            && new Set(parts.map(v => v[1].toLowerCase())).size === parts.length ? null : 'Enter a whole-number washroom count (zero is allowed).';
    }
    return null;
}

const mode = row => String(row?.handoverType || 'FIXED').toUpperCase();
const unit = row => String(row?.handoverLeadUnit || '').toUpperCase();
const day = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
const activeHandover = row => mode(row) === 'VARIABLE'
    ? [mode(row), isBlankAnswer(row?.handoverLeadValue) ? '' : String(row.handoverLeadValue), unit(row)]
    : [mode(row), day(row?.handoverDate)];
const hasHandoverAnswer = row => activeHandover(row).slice(1).some(v => !isBlankAnswer(v));

function washroomCounts(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const parts = value.split(';').map(v => /^(Male|Female):\s*(\d+)$/i.exec(v.trim()));
    if (parts.some(v => !v) || new Set(parts.map(v => v[1].toLowerCase())).size !== parts.length) return null;
    return Object.fromEntries(parts.map(v => [v[1].toLowerCase(), v[2]]));
}

// Raw saved values, rather than form defaults, are the client's concurrency baseline.
function pptFormSnapshot(original) {
    if (original == null) return null;
    const row = flatFormValues(original);
    return Object.fromEntries([...PPT_FORM_FIELDS.map(f => f.key), ...HANDOVER_FIELDS].map(key => {
        const value = row[key] ?? null;
        return [key, key === 'handoverDate' && value != null ? day(value) : Array.isArray(value) ? [...value] : value];
    }));
}

function sameFormAnswer(key, a, b) {
    if (key === 'handoverType') return mode({ handoverType: a }) === mode({ handoverType: b });
    if (key === 'handoverDate') return day(a) === day(b);
    if (key === 'handoverLeadUnit') return unit({ handoverLeadUnit: a }) === unit({ handoverLeadUnit: b });
    if (key === 'handoverLeadValue') return sameAnswer(a == null ? null : String(a), b == null ? null : String(b));
    return sameAnswer(a, b);
}

function pptFormIssues(original, edits) {
    const before = original == null ? null : flatFormValues(original);
    const patch = flatFormValues(edits);
    const after = { ...before, ...patch };
    const issues = [];
    for (const field of PPT_FORM_FIELDS) {
        if (before && (!Object.hasOwn(patch, field.key) || sameAnswer(before[field.key], after[field.key]))) continue;
        const value = after[field.key];
        let message = isBlankAnswer(value)
            ? `${field.label} ${before && !isBlankAnswer(before[field.key]) ? 'cannot be cleared' : 'is required'}.`
            : fieldAnswerError(field, value);
        if (!message && before && field.kind === 'washrooms') {
            const previous = washroomCounts(before[field.key]), next = washroomCounts(value);
            const cleared = ['male', 'female'].filter(key => previous && Object.hasOwn(previous, key) && !Object.hasOwn(next || {}, key));
            if (cleared.length) message = `${cleared.map(key => key[0].toUpperCase() + key.slice(1)).join(' and ')} washroom count cannot be cleared.`;
        }
        if (message) issues.push({ path: field.nested ? ['warehouseData', field.key] : [field.key], message });
    }
    if (!before || HANDOVER_FIELDS.some(key => Object.hasOwn(patch, key))) {
        const addIssue = (key, message) => {
            if (!issues.some(issue => issue.path[0] === key)) issues.push({ path: [key], message });
        };
        if (before) HANDOVER_FIELDS.forEach((key, index) => {
            if (Object.hasOwn(patch, key) && !isBlankAnswer(before[key]) && isBlankAnswer(after[key])) {
                addIssue(key, `${HANDOVER_LABELS[index]} cannot be cleared.`);
            }
        });
        const unchanged = before && sameAnswer(activeHandover(before), activeHandover(after));
        const emptyLegacy = before && !hasHandoverAnswer(before) && !hasHandoverAnswer(after);
        if (!unchanged && !emptyLegacy) {
            if (!['FIXED', 'VARIABLE'].includes(mode(after))) addIssue('handoverType', 'Select Fixed or Variable handover.');
            else if (mode(after) === 'VARIABLE') {
                const lead = after.handoverLeadValue;
                if (!['number', 'string'].includes(typeof lead) || !/^\d+$/.test(String(lead)) || Number(lead) < 1 || Number(lead) > 120) {
                    addIssue('handoverLeadValue', 'Enter a handover lead time between 1 and 120.');
                }
                if (!['DAYS', 'WEEKS', 'MONTHS'].includes(unit(after))) addIssue('handoverLeadUnit', 'Select a handover lead-time unit.');
            } else if (!validCalendarDate(after.handoverDate)) addIssue('handoverDate', 'Enter a complete, valid handover date.');
        }
    }
    return issues;
}

function pptFieldRequired(original, key) {
    if (!original) return true;
    const row = flatFormValues(original);
    return HANDOVER_FIELDS.includes(key) ? hasHandoverAnswer(row) : !isBlankAnswer(row[key]);
}

module.exports = { PPT_FORM_FIELDS, HANDOVER_FIELDS, flatFormValues, isBlankAnswer, pptFormIssues, pptFieldRequired, pptFormSnapshot, sameFormAnswer };
