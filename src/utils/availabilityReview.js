const { z } = require('zod');

const todayInIndia = (now = new Date()) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now);

// Middleware and services both validate, so accept an already validated UTC date
// as well as the wire format. Never coerce timestamps or rollover dates.
const calendarDateSchema = z.union([
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
        const date = new Date(value + 'T00:00:00.000Z');
        return value.slice(0, 4) !== '0000' && !Number.isNaN(date.getTime())
            && date.toISOString().slice(0, 10) === value;
    }, 'Enter a valid calendar date'),
    z.date().refine(value => value.toISOString().endsWith('T00:00:00.000Z'), 'Enter a calendar date'),
]).transform(value => typeof value === 'string' ? new Date(value + 'T00:00:00.000Z') : value);

const reviewDateSchema = calendarDateSchema.refine(
    value => value.toISOString().slice(0, 10) <= todayInIndia(),
    'Availability last reviewed cannot be in the future',
);
const expectedAvailabilitySchema = z.object({
    availability: z.string().nullable(),
    availabilityLastReviewedOn: calendarDateSchema.nullable(),
}).strict();

const dateKey = value => value == null ? null : (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
const samePair = (a, b) => (a.availability ?? null) === (b.availability ?? null)
    && dateKey(a.availabilityLastReviewedOn) === dateKey(b.availabilityLastReviewedOn);
const normalizeAvailability = value => value?.trim().toLowerCase() || null;
const availabilityConflict = () => Object.assign(new Error(
    'Availability or its review date changed while this form was open. Refresh the list, reopen the record, and check the latest values before saving.',
), { name: 'AvailabilityConflictError', statusCode: 409 });

function validateReviewAvailability(data) {
    if (data.availabilityLastReviewedOn != null && !normalizeAvailability(data.availability)) {
        throw Object.assign(new Error('Select availability before recording a review date'), {
            name: 'ValidationError',
            issues: [{ path: ['availabilityLastReviewedOn'], message: 'Select availability before recording a review date' }],
        });
    }
}

// The client snapshot protects the pair, including a date-only edit after someone
// else changes Yes/No. Older clients still get a guard against a mid-request race.
// Return the condition for the actual UPDATE, not just a read-before-write check.
function prepareAvailabilityUpdate(existing, data, expected) {
    const hasStatus = Object.hasOwn(data, 'availability');
    const hasDate = Object.hasOwn(data, 'availabilityLastReviewedOn');
    if (!hasStatus && !hasDate) return undefined;

    const baseline = expected || existing;
    const intended = {
        availability: hasStatus ? data.availability : baseline.availability,
        availabilityLastReviewedOn: hasDate ? data.availabilityLastReviewedOn : baseline.availabilityLastReviewedOn,
    };
    if (hasStatus && !hasDate && normalizeAvailability(data.availability) !== normalizeAvailability(baseline.availability)) {
        // A new answer without evidence cannot inherit the old answer's check date.
        intended.availabilityLastReviewedOn = data.availabilityLastReviewedOn = null;
    }
    validateReviewAvailability(intended);

    if (samePair(existing, intended)) {
        // Includes a retry after the first save succeeded but its response was lost.
        delete data.availability;
        delete data.availabilityLastReviewedOn;
        return undefined;
    }
    if (expected && !samePair(existing, expected)) throw availabilityConflict();
    return {
        availability: baseline.availability ?? null,
        availabilityLastReviewedOn: baseline.availabilityLastReviewedOn == null
            ? null : new Date(dateKey(baseline.availabilityLastReviewedOn) + 'T00:00:00.000Z'),
    };
}

module.exports = { todayInIndia, reviewDateSchema, expectedAvailabilitySchema,
    validateReviewAvailability, prepareAvailabilityUpdate, availabilityConflict };
