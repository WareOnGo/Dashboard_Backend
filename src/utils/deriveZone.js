// src/utils/deriveZone.js

/**
 * Derive the operational zone for a warehouse from its Indian state/UT name.
 *
 * The Scout form no longer collects zone — it is autofilled here from the
 * `state` entry so the value stays canonical and consistent regardless of how
 * the submission was entered. Matching is case-insensitive and whitespace
 * tolerant. Unknown / unmapped / empty states fall back to 'MISC'.
 *
 * @param {string} state - State or union territory name as entered.
 * @returns {'NORTH'|'WEST'|'SOUTH'|'EAST'|'CENTRAL'|'MISC'}
 */
function deriveZone(state) {
    if (typeof state !== 'string') return 'MISC';
    const s = state.toLowerCase().trim();
    switch (s) {
        // --- NORTH ZONE ---
        case 'jammu and kashmir':
        case 'ladakh':
        case 'punjab':
        case 'himachal pradesh':
        case 'haryana':
        case 'chandigarh':
        case 'uttarakhand':
        case 'delhi':
        case 'rajasthan':
        case 'uttar pradesh':
            return 'NORTH';

        // --- WEST ZONE ---
        case 'gujarat':
        case 'maharashtra':
        case 'goa':
        case 'dadra and nagar haveli and daman and diu':
            return 'WEST';

        // --- SOUTH ZONE ---
        case 'karnataka':
        case 'telangana':
        case 'andhra pradesh':
        case 'kerala':
        case 'tamil nadu':
        case 'puducherry':
        case 'lakshadweep':
        case 'andaman and nicobar islands':
            return 'SOUTH';

        // --- EAST ZONE (includes North-East) ---
        case 'bihar':
        case 'jharkhand':
        case 'west bengal':
        case 'sikkim':
        case 'arunachal pradesh':
        case 'nagaland':
        case 'manipur':
        case 'mizoram':
        case 'tripura':
        case 'meghalaya':
        case 'assam':
            return 'EAST';

        // --- CENTRAL ZONE ---
        case 'madhya pradesh':
        case 'chhattisgarh':
        case 'odisha':
            return 'CENTRAL';

        default:
            return 'MISC';
    }
}

module.exports = { deriveZone };
