const text = value => typeof value === 'string' ? value.trim() : '';
// Keep older open clients working until the new forms have been rolled out.
const requiresNewFormFields = () => process.env.WAREHOUSE_FORM_REQUIREMENTS_ENFORCED === 'true';

// Compare to the stored row, so unchanged missing/legacy values need no migration
// or historical flags. Callers pass the flattened land/location fields.
async function validateFormChanges(original, edits) {
    if (!requiresNewFormFields()) return null;
    if (Object.hasOwn(edits, 'landType') && text(edits.landType) !== text(original.landType)
        && !text(edits.landType)) {
        throw Object.assign(new Error('Land Type cannot be cleared.'), {
            name: 'ValidationError', statusCode: 400,
            issues: [{ path: ['warehouseData', 'landType'], message: 'Land Type cannot be cleared.' }],
        });
    }
    if (Object.hasOwn(edits, 'googleLocation') && text(edits.googleLocation) !== text(original.googleLocation)) {
        if (!text(edits.googleLocation)) {
            throw Object.assign(new Error('Google Location URL cannot be cleared.'), {
                name: 'ValidationError', statusCode: 400,
                issues: [{ path: ['googleLocation'], message: 'Google Location URL cannot be cleared.' }],
            });
        }
        edits.googleLocation = text(edits.googleLocation);
    }
    return null;
}

module.exports = { validateFormChanges, requiresNewFormFields };
