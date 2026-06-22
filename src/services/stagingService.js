// src/services/stagingService.js
const BaseService = require('./baseService');
const WarehouseValidator = require('../validators/warehouseValidator');
const { geocodeUrl } = require('../utils/googleMaps');
const { deriveZone } = require('../utils/deriveZone');

/**
 * The nested WarehouseData fields, flattened onto the StagedWarehouse mirror.
 * Single source of truth for splitting flat <-> nested (see drift test).
 */
const WAREHOUSE_DATA_FIELDS = [
    'latitude', 'longitude', 'fireNocAvailable', 'fireSafetyMeasures', 'landType',
    'approachRoadWidth', 'dimensions', 'parkingDockingSpace', 'pollutionZone',
    'powerKva', 'vaastuCompliance',
];

/** StagedWarehouse columns that are pipeline metadata, never warehouse data. */
const STAGING_META_FIELDS = new Set([
    'id', 'reviewStatus', 'source', 'submittedBy', 'submittedAt', 'reviewedBy',
    'reviewedAt', 'rejectionReason', 'warehouseId', 'rawPayload', 'flags', 'reviewMeta',
]);

const REVIEWABLE = new Set(['PENDING']);

/**
 * AUTO-APPROVE FLAG (temporary).
 *
 * When true, freshly staged submissions are promoted to the master Warehouse
 * immediately on creation instead of waiting in the PENDING review queue.
 * Flip to false to restore manual admin approval.
 *
 * Auto-approval is best-effort: a submission that fails strict warehouse
 * validation (e.g. a partial PARTNER_API ingest payload) is left PENDING for a
 * human to fix rather than failing the submission outright.
 */
const AUTO_APPROVE_SUBMISSIONS = true;

/** Reviewer attribution recorded on rows promoted by the auto-approve flag. */
const AUTO_APPROVE_REVIEWER = Object.freeze({
    email: 'system:auto-approve',
    name: 'Auto Approver',
});

/** Default page size for the review queue when the caller doesn't specify a limit. */
const DEFAULT_LIST_LIMIT = 100;

function notFound(id) {
    const error = new Error(`Staged submission ${id} not found`);
    error.name = 'NotFoundError';
    error.statusCode = 404;
    return error;
}

function conflict(message) {
    const error = new Error(message);
    error.name = 'ConflictError';
    error.statusCode = 409;
    return error;
}

function validationError(message, issues) {
    const error = new Error(message);
    error.name = 'ValidationError';
    error.issues = issues;
    error.statusCode = 400;
    return error;
}

/**
 * StagingService handles inbound submissions for the validation layer.
 *
 * Submissions are written to the StagedWarehouse table (PENDING) instead of
 * going straight into the master Warehouse table. They are later reviewed,
 * edited, and promoted by an admin (see Phase 2). See
 * docs/STAGING_VALIDATION_LAYER.md.
 */
class StagingService extends BaseService {
    constructor(stagedWarehouseModel, warehouseService) {
        super();
        this.stagedWarehouseModel = stagedWarehouseModel;
        this.warehouseService = warehouseService;
    }

    /**
     * Stage a Scout submission.
     *
     * The submission has already passed strict createWarehouseSchema validation
     * (the Scout endpoint keeps that gate so the Scout frontend still gets
     * field-level errors). We flatten its nested `warehouseData` into the
     * mirror columns and snapshot the submission into `rawPayload`.
     *
     * @param {Object} params
     * @param {Object} params.submission - Validated warehouse payload (with nested warehouseData)
     * @param {Object} params.scout - req.scout { id, empid, name, email, status }
     * @returns {Object} Created staged row
     */
    async createScoutSubmission({ submission, scout }) {
        return this.executeOperation(async () => {
            const staged = this.toStagedRow(submission, {
                source: 'SCOUT',
                submittedBy: scout.email || scout.name,
            });
            await this.autofillCoordinatesFromUrl(staged);
            const created = await this.stagedWarehouseModel.create(staged);
            return this.maybeAutoApprove(created);
        });
    }

    /**
     * Stage a dashboard (authenticated internal user) submission.
     *
     * Dashboard submissions get the same review scrutiny as Scout ones — they no
     * longer write straight to the master Warehouse table. The submission has
     * already passed strict createWarehouseSchema validation upstream.
     *
     * @param {Object} params
     * @param {Object} params.submission - Validated warehouse payload (with nested warehouseData)
     * @param {Object} params.user - req.user { id, email, name, ... }
     * @returns {Object} Created staged row
     */
    async createDashboardSubmission({ submission, user }) {
        return this.executeOperation(async () => {
            const staged = this.toStagedRow(submission, {
                source: 'DASHBOARD',
                submittedBy: user.email,
            });
            await this.autofillCoordinatesFromUrl(staged);
            const created = await this.stagedWarehouseModel.create(staged);
            return this.maybeAutoApprove(created);
        });
    }

    /**
     * Stage a generic external webhook submission (POST /api/staging/ingest).
     *
     * Accept-and-store: the payload has passed only the relaxed `ingestSchema`
     * (all fields optional), so it may be partial/messy. It is stored as PENDING
     * for human review and re-validated strictly at approval. `toStagedRow` forces
     * `uploadedBy/wogVerified:false/visibility:false`, so an external caller cannot
     * self-approve or spoof verification.
     *
     * @param {Object} params
     * @param {Object} params.submission - Relaxed warehouse payload (may be partial)
     * @param {string} [params.source='PARTNER_API'] - Source tag for provenance
     * @param {string} [params.submittedBy='webhook:partner_api'] - Actor label (no user/scout)
     * @returns {Object} Created staged row
     */
    async createIngestSubmission({ submission, source = 'PARTNER_API', submittedBy = 'webhook:partner_api' }) {
        return this.executeOperation(async () => {
            const staged = this.toStagedRow(submission, { source, submittedBy });
            await this.autofillCoordinatesFromUrl(staged);
            const created = await this.stagedWarehouseModel.create(staged);
            return this.maybeAutoApprove(created);
        });
    }

    /**
     * Map a validated warehouse submission into a flat StagedWarehouse row.
     * Forced fields (source identity, verification flags) always win over the
     * submission so a caller cannot self-approve or spoof attribution.
     *
     * @param {Object} submission - Validated payload with nested `warehouseData`
     * @param {Object} meta - { source, submittedBy }
     * @returns {Object} Flat staged row ready for Prisma
     * @private
     */
    toStagedRow(submission, { source, submittedBy }) {
        const { warehouseData = {}, ...flatWarehouse } = submission;

        // Autofill zone from state only when the client didn't send one. The Scout
        // form dropped the field (so it's derived), while the dashboard form still
        // lets a user pick/edit zone explicitly — that choice is respected here and
        // on the edit path (editSubmission), keeping create and edit consistent.
        const sentZone = typeof flatWarehouse.zone === 'string' ? flatWarehouse.zone.trim() : '';
        const zone = sentZone || deriveZone(flatWarehouse.state);

        return {
            source,
            submittedBy,
            reviewStatus: 'PENDING',
            // Immutable snapshot of the submission as accepted (strict-validated for Scout).
            rawPayload: submission,

            // Mirror columns: top-level warehouse fields + flattened nested geo/extra fields.
            ...flatWarehouse,
            ...warehouseData,

            // Zone is derived from state server-side (clients no longer send it), so the
            // value stays canonical. Must come after the spreads to win over any
            // client-sent zone.
            zone,

            // Forced fields — must win over anything in the submission.
            uploadedBy: submittedBy,
            wogVerified: false,
            visibility: false,
        };
    }

    /**
     * Best-effort autofill of latitude/longitude from the submission's Google
     * Maps URL (`googleLocation`). Mutates the flat staged row in place.
     *
     * Never throws — a geocoding failure (bad URL, network, Google changes)
     * must not block a submission, which just gets staged without coordinates.
     * Won't overwrite coordinates the submission already supplied.
     *
     * @param {Object} staged - Flat staged row produced by toStagedRow
     * @returns {Promise<void>}
     * @private
     */
    async autofillCoordinatesFromUrl(staged) {
        if (!staged.googleLocation) return;
        if (staged.latitude != null && staged.longitude != null) return;

        try {
            const { lat, lng } = await geocodeUrl(staged.googleLocation);
            if (lat != null && lng != null) {
                staged.latitude = lat;
                staged.longitude = lng;
            }
        } catch {
            // best-effort; the submission proceeds without coordinates
        }
    }

    /**
     * On edit, re-geocode latitude/longitude only when the submission's
     * `googleLocation` actually changes. Mutates the flat `mapped` edits in place.
     *
     * Never throws (best-effort). If the same edit explicitly sets latitude and
     * longitude, those win and no geocoding happens. If the URL is cleared,
     * existing coordinates are left untouched rather than fabricated.
     *
     * @param {Object} row - The current staged row (pre-edit)
     * @param {Object} mapped - The flattened proposed edits (post flattenForMirror)
     * @returns {Promise<void>}
     * @private
     */
    async autofillCoordinatesOnUrlChange(row, mapped) {
        const urlChanged =
            'googleLocation' in mapped && mapped.googleLocation !== row.googleLocation;
        if (!urlChanged) return;
        // Respect explicit coordinate edits made in the same request.
        if (mapped.latitude != null && mapped.longitude != null) return;
        // URL cleared — don't invent coordinates from nothing.
        if (!mapped.googleLocation) return;

        try {
            const { lat, lng } = await geocodeUrl(mapped.googleLocation);
            if (lat != null && lng != null) {
                mapped.latitude = lat;
                mapped.longitude = lng;
            }
        } catch {
            // best-effort; the edit proceeds without refreshed coordinates
        }
    }

    /**
     * List staged submissions (review queue), newest first.
     * @param {Object} options - { reviewStatus?, page?, limit? }
     * @returns {Array} Staged rows
     */
    async listSubmissions({ reviewStatus, page, limit } = {}) {
        return this.executeOperation(async () => {
            // Always cap the result set so an ever-growing queue (APPROVED/ALL tabs never
            // shrink) can't return an unbounded, heavy payload. Validator caps limit at 100.
            const take = limit || DEFAULT_LIST_LIMIT;
            const skip = page ? (page - 1) * take : undefined;
            return this.stagedWarehouseModel.findAll({ reviewStatus, skip, take });
        });
    }

    /**
     * Get a single staged submission.
     * @param {string} id
     * @returns {Object} Staged row
     */
    async getSubmission(id) {
        return this.executeOperation(async () => {
            const row = await this.stagedWarehouseModel.findByStagedId(id);
            if (!row) throw notFound(id);
            return row;
        });
    }

    /**
     * Apply reviewer edits to a staged submission. The row stays PENDING.
     * Returns the updated row plus a field-level diff for audit logging.
     * @param {string} id
     * @param {Object} edits - Validated partial warehouse payload (may contain nested warehouseData)
     * @returns {{ submission: Object, changes: Array<{field, from, to}> }}
     */
    async editSubmission(id, edits) {
        return this.executeOperation(async () => {
            const row = await this.stagedWarehouseModel.findByStagedId(id);
            if (!row) throw notFound(id);
            if (!REVIEWABLE.has(row.reviewStatus)) {
                throw conflict('Only pending submissions can be edited. Move it back to pending first.');
            }

            const mapped = this.flattenForMirror(edits);
            // Re-geocode only when the Google Maps URL itself changes. Done before
            // computeDiff so the refreshed coordinates show up in the returned changes.
            await this.autofillCoordinatesOnUrlChange(row, mapped);
            const changes = this.computeDiff(row, mapped);
            if (changes.length === 0) {
                return { submission: row, changes: [] };
            }

            const updated = await this.stagedWarehouseModel.updateStaged(id, mapped);
            return { submission: updated, changes };
        });
    }

    /**
     * Approve a staged submission: re-validate with the strict warehouse schema,
     * then promote it into the master Warehouse table (claim-first + compensation,
     * not an interactive transaction — see promote()). On validation failure the
     * row stays PENDING and a ValidationError (with issues) is thrown so the
     * reviewer can fix the flagged fields.
     * @param {string} id
     * @param {Object} reviewer - { email, name?, ip? }
     * @returns {Object} The created master Warehouse
     */
    async approveSubmission(id, reviewer) {
        return this.executeOperation(async () => {
            const row = await this.stagedWarehouseModel.findByStagedId(id);
            if (!row) throw notFound(id);
            if (!REVIEWABLE.has(row.reviewStatus)) {
                throw conflict('Submission is not in a reviewable state (already approved or rejected).');
            }

            const payload = this.buildPromotionPayload(row);
            const result = WarehouseValidator.validateCreate(payload);
            if (!result.success) {
                throw validationError(
                    'Staged submission fails warehouse validation; fix the flagged fields before approving.',
                    result.error.issues,
                );
            }

            const processed = this.warehouseService.applyCreateBusinessRules(result.data);
            // Approval couples visibility: approved => not hidden.
            processed.visibility = true;
            // wogVerified is a SEPARATE trust signal with its own process — approval never
            // sets it. It flows through from the staged row (false at ingest).
            // uploadedBy is preserved from the original submission.

            return this.stagedWarehouseModel.promote(id, processed, reviewer);
        });
    }

    /**
     * Reject a staged submission with a reason.
     * @param {string} id
     * @param {Object} reviewer - { email, name?, ip? }
     * @param {string} rejectionReason
     * @returns {Object} Updated staged row
     */
    async rejectSubmission(id, reviewer, rejectionReason) {
        return this.executeOperation(async () => {
            const row = await this.stagedWarehouseModel.findByStagedId(id);
            if (!row) throw notFound(id);
            return this.stagedWarehouseModel.reject(id, reviewer, rejectionReason);
        });
    }

    /**
     * Delete a staged submission. Removes only the staging record — any promoted master
     * Warehouse (for an APPROVED row) is left in place.
     * @param {string} id
     * @returns {Object} { id, previousStatus, warehouseId }
     */
    async deleteSubmission(id) {
        return this.executeOperation(async () => {
            const row = await this.stagedWarehouseModel.findByStagedId(id);
            if (!row) throw notFound(id);
            await this.stagedWarehouseModel.deleteStaged(id);
            return { id, previousStatus: row.reviewStatus, warehouseId: row.warehouseId };
        });
    }

    /**
     * Move an APPROVED or REJECTED submission back to PENDING (revoke / un-reject).
     * @param {string} id
     * @param {Object} reviewer - { email, name?, ip? }
     * @returns {Object} The reopened (PENDING) staged row
     */
    async reopenSubmission(id, reviewer) {
        return this.executeOperation(async () => {
            const row = await this.stagedWarehouseModel.findByStagedId(id);
            if (!row) throw notFound(id);
            return this.stagedWarehouseModel.reopen(row, reviewer);
        });
    }

    // --- helpers ---

    /**
     * Auto-approve hook for freshly staged rows. When AUTO_APPROVE_SUBMISSIONS is
     * on, promote the row immediately and return the refreshed (APPROVED) row.
     * Best-effort: if the row can't be validated/promoted (e.g. a partial ingest
     * payload that fails strict validation), it's left PENDING and returned as-is.
     * @param {Object} staged - The just-created staged row
     * @returns {Promise<Object>} The staged row (APPROVED if promotion succeeded)
     * @private
     */
    async maybeAutoApprove(staged) {
        if (!AUTO_APPROVE_SUBMISSIONS) return staged;
        try {
            await this.approveSubmission(staged.id, AUTO_APPROVE_REVIEWER);
        } catch (error) {
            // Leave the row PENDING for manual review if it can't be auto-approved.
            if (error && error.name === 'ValidationError') return staged;
            throw error;
        }
        return this.stagedWarehouseModel.findByStagedId(staged.id);
    }

    /**
     * Flatten a warehouse payload (with nested warehouseData) into mirror columns,
     * dropping any pipeline-metadata keys defensively.
     * @private
     */
    flattenForMirror(payload) {
        const { warehouseData = {}, ...flat } = payload;
        const merged = { ...flat, ...warehouseData };
        const out = {};
        for (const [key, value] of Object.entries(merged)) {
            if (STAGING_META_FIELDS.has(key)) continue;
            out[key] = value;
        }
        return out;
    }

    /**
     * Reconstruct the nested promotion payload { ...warehouseFields, warehouseData }
     * from a flat staged row.
     * @private
     */
    buildPromotionPayload(row) {
        const warehouseData = {};
        for (const field of WAREHOUSE_DATA_FIELDS) {
            warehouseData[field] = row[field] ?? null;
        }
        const warehouse = {};
        for (const [key, value] of Object.entries(row)) {
            if (STAGING_META_FIELDS.has(key)) continue;
            if (WAREHOUSE_DATA_FIELDS.includes(key)) continue;
            warehouse[key] = value;
        }
        return { ...warehouse, warehouseData };
    }

    /**
     * Field-level before/after diff between a staged row and proposed edits.
     * @private
     */
    computeDiff(row, edits) {
        const changes = [];
        for (const [field, to] of Object.entries(edits)) {
            const from = row[field];
            if (JSON.stringify(from ?? null) !== JSON.stringify(to ?? null)) {
                changes.push({ field, from, to });
            }
        }
        return changes;
    }
}

StagingService.WAREHOUSE_DATA_FIELDS = WAREHOUSE_DATA_FIELDS;
StagingService.STAGING_META_FIELDS = STAGING_META_FIELDS;

module.exports = StagingService;
