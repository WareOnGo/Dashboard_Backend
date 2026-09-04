// src/utils/submissionResult.js

/**
 * Warehouse-ish fields echoed back to the submitter so a client can confirm what
 * was recorded without a follow-up fetch. Deliberately short: the create response
 * is a receipt, not a warehouse payload.
 */
const ECHO_FIELDS = ['warehouseType', 'city', 'state', 'zone'];

/**
 * Shape a freshly created StagedWarehouse row into the create-endpoint receipt.
 *
 * The two IDs in play have different types and different meanings, and the raw
 * staged row names only one of them `id` — which is how scouts ended up being
 * shown a staging uuid labelled "Warehouse ID". This names both explicitly:
 *
 * - `submissionId` — the StagedWarehouse uuid. The review/pullback handle; always present.
 * - `warehouseId`  — the master Warehouse autoincrement Int. Present only once the
 *                    submission has actually been promoted (autopilot on and the
 *                    payload passed strict validation), `null` otherwise.
 *
 * `autoApproved` requires both an APPROVED status and a real `warehouseId`, so it
 * can never claim a published warehouse that isn't there.
 *
 * `id` is retained as the staging uuid for backward compatibility — it is NOT
 * switched to the numeric master id, since existing readers expect a uuid.
 * `rawPayload` (a full echo of the submission) and `warehouseDeleted` (a read-time
 * annotation that is meaningless on a fresh row) are dropped.
 *
 * @param {Object} staged - The staged row returned by StagingService.create*Submission
 * @returns {Object} Submission receipt
 */
function toSubmissionResult(staged) {
    const warehouseId = staged.warehouseId ?? null;

    const result = {
        submissionId: staged.id,
        // Retained for backward compatibility; same value as submissionId.
        id: staged.id,
        warehouseId,
        reviewStatus: staged.reviewStatus,
        autoApproved: staged.reviewStatus === 'APPROVED' && warehouseId != null,
    };

    for (const field of ECHO_FIELDS) {
        result[field] = staged[field] ?? null;
    }

    return result;
}

module.exports = { toSubmissionResult, ECHO_FIELDS };
