// src/services/stagingService.js
const BaseService = require('./baseService');
const WarehouseValidator = require('../validators/warehouseValidator');
const { geocodeUrl } = require('../utils/googleMaps');
const { deriveZone } = require('../utils/deriveZone');
const { computeChanges } = require('../utils/auditDiff');
const { editorIdentity } = require('../utils/editorIdentity');
const { prepareAvailabilityUpdate, validateReviewAvailability } = require('../utils/availabilityReview');
const { rankWarehouses, parseIdList } = require('../utils/warehouseSearchRanking');

/**
 * The nested WarehouseData fields, flattened onto the StagedWarehouse mirror.
 * Single source of truth for splitting flat <-> nested (see drift test).
 */
const WAREHOUSE_DATA_FIELDS = [
    'latitude', 'longitude', 'fireNocAvailable', 'fireSafetyMeasures', 'landType',
    'approachRoadWidth', 'dimensions', 'parkingDockingSpace', 'pollutionZone',
    'powerKva', 'vaastuCompliance',
];

/**
 * Server-owned metadata excluded from editable warehouse payloads.
 * lastEditedBy is copied separately from the saved row during promotion.
 * `warehouseDeleted` is not a column at all but a read-time annotation added by
 * StagedWarehouseModel.annotateWarehouseExistence — it belongs here for the same reason:
 * without it, buildPromotionPayload leaks it into the promotion payload, where it survives
 * only because createWarehouseSchema is a non-strict z.object() that strips unknown keys.
 */
const STAGING_META_FIELDS = new Set([
    'id', 'reviewStatus', 'source', 'submittedBy', 'submittedAt', 'reviewedBy',
    'reviewedAt', 'rejectionReason', 'warehouseId', 'rawPayload', 'flags', 'reviewMeta',
    'warehouseDeleted', 'lastEditedBy', '__editVersion',
]);

const REVIEWABLE = new Set(['PENDING']);

/**
 * AUTO-APPROVE ("autopilot").
 *
 * When on, freshly staged submissions are promoted to the master Warehouse
 * immediately on creation instead of waiting in the PENDING review queue. The
 * state now lives in the DB (app_setting) and is toggled at runtime by an admin
 * from the review panel — see SettingsService.getAutoApprove(). It is read per
 * submission in maybeAutoApprove().
 *
 * The staging row is kept either way — it stays the audit record and the pullback
 * handle (see StagedWarehouseModel.reopen, which deletes the promoted warehouse and
 * returns the row to PENDING). Autopilot skips the human gate, not the paper trail.
 *
 * Auto-approval is best-effort: anything that stops a promotion (a partial
 * PARTNER_API payload failing strict warehouse validation, a transient DB error)
 * leaves the row PENDING for a human rather than failing the submission outright.
 */

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
    constructor(stagedWarehouseModel, warehouseService, settingsService, voiceNoteService = null) {
        super();
        this.stagedWarehouseModel = stagedWarehouseModel;
        this.warehouseService = warehouseService;
        this.settingsService = settingsService;
        this.voiceNoteService = voiceNoteService;
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
        if (submission.scoutVoiceNotes?.length) {
            if (!this.voiceNoteService) throw require('../utils/voiceNotes').fail('Voice uploads are unavailable.', 503);
            return this.voiceNoteService.withAttachments(submission.scoutVoiceNotes, scout, canonical =>
                this.saveScoutSubmission({ submission: { ...submission, scoutVoiceNotes: canonical }, scout }), submission);
        }
        return this.saveScoutSubmission({ submission, scout });
    }

    async saveScoutSubmission({ submission, scout }) {
        return this.executeOperation(async () => {
            const staged = this.toStagedRow(submission, {
                source: 'SCOUT',
                submittedBy: scout.email || scout.name,
                lastEditedBy: editorIdentity(scout),
            });
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
        require('../utils/voiceNotes').retainVoiceNotes(submission);
        return this.executeOperation(async () => {
            const staged = this.toStagedRow(submission, {
                source: 'DASHBOARD',
                submittedBy: user.email,
                lastEditedBy: editorIdentity(user),
            });
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
        require('../utils/voiceNotes').retainVoiceNotes(submission);
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
     * @param {Object} meta - { source, submittedBy, lastEditedBy? }
     * @returns {Object} Flat staged row ready for Prisma
     * @private
     */
    toStagedRow(submission, { source, submittedBy, lastEditedBy = null }) {
        validateReviewAvailability(submission);
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
            lastEditedBy,
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
     * List staged submissions (review queue), newest first, or by relevance when
     * searching.
     *
     * A search runs over the whole tab, not just its newest page, with the
     * dashboard's matcher (utils/warehouseSearchRanking). A pasted ID list
     * matches the warehouse each submission belongs to, in pasted order.
     * @param {Object} options - { reviewStatus?, page?, limit?, search? }
     * @returns {Array} Staged rows
     */
    async listSubmissions({ reviewStatus, page, limit, search } = {}) {
        return this.executeOperation(async () => {
            // Always cap the result set so an ever-growing queue (APPROVED/ALL tabs never
            // shrink) can't return an unbounded, heavy payload. Validator caps limit at 100.
            const take = limit || DEFAULT_LIST_LIMIT;
            const skip = page ? (page - 1) * take : 0;
            const term = search?.trim();
            if (!term) return this.stagedWarehouseModel.findAll({ reviewStatus, skip, take });

            const candidates = await this.stagedWarehouseModel.findSearchCandidates({ reviewStatus });
            const idList = parseIdList(term);
            let ranked;
            if (idList) {
                const position = new Map(idList.ids.map((id, index) => [id, index]));
                // Stable sort: submissions for the same warehouse stay newest first.
                ranked = candidates.filter((row) => position.has(row.warehouseId))
                    .sort((a, b) => position.get(a.warehouseId) - position.get(b.warehouseId));
            } else {
                ranked = rankWarehouses(term, candidates, { recency: (row) => row.submittedAt }).map((match) => match.row);
            }

            const pageIds = ranked.slice(skip, skip + take).map((row) => row.id);
            const rows = await this.stagedWarehouseModel.findByIds(pageIds);
            const byId = new Map(rows.map((row) => [row.id, row]));
            return pageIds.map((id) => byId.get(id)).filter(Boolean);
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
     * @param {Object} [user] - Authenticated editor, supplied by the controller
     * @returns {{ submission: Object, changes: Array<{field, from, to}> }}
     */
    async editSubmission(id, edits, user) {
        return this.executeOperation(async () => {
            const row = await this.stagedWarehouseModel.findByStagedId(id);
            if (!row) throw notFound(id);
            if (!REVIEWABLE.has(row.reviewStatus)) {
                throw conflict('Only pending submissions can be edited. Move it back to pending first.');
            }

            const { expectedAvailability, ...fields } = edits;
            const mapped = this.flattenForMirror(fields);
            delete mapped.uploadedBy;
            const availabilityGuard = prepareAvailabilityUpdate(row, mapped, expectedAvailability);
            require('../utils/voiceNotes').retainVoiceNotes(mapped, row);
            // Enforce required fields only after the compatibility rollout.
            // Saving never waits on Maps resolution.
            await require('../utils/formChanges').validateFormChanges(row, mapped);
            const changes = this.computeDiff(row, mapped);
            if (changes.length === 0) {
                return { submission: row, changes: [] };
            }

            const lastEditedBy = editorIdentity(user);
            if (lastEditedBy) mapped.lastEditedBy = lastEditedBy;
            const updated = await this.stagedWarehouseModel.updateStaged(id, mapped, availabilityGuard);
            return { submission: updated, changes };
        });
    }

    /**
     * Approve a staged submission: re-validate with the strict warehouse schema,
     * then atomically create the master and approval link in one SQL statement
     * (without an interactive transaction — see promote()). On validation failure the
     * row stays PENDING and a ValidationError (with issues) is thrown so the
     * reviewer can fix the flagged fields.
     * @param {string} id
     * @param {Object} reviewer - { email, name?, ip? }
     * @returns {Object} The created master Warehouse
     */
    async approveSubmission(id, reviewer) {
        return this.executeOperation(async () => {
            const row = await this.stagedWarehouseModel.findByStagedId(id, { includeVersion: true });
            if (!row) throw notFound(id);
            if (!REVIEWABLE.has(row.reviewStatus)) {
                throw conflict('Submission is not in a reviewable state (already approved or rejected).');
            }
            if (!/^\d+$/.test(row.__editVersion || '')) throw new Error('Submission revision unavailable');

            const payload = this.buildPromotionPayload(row);
            const result = WarehouseValidator.validateCreate(payload);
            if (!result.success) {
                throw validationError(
                    'Staged submission fails warehouse validation; fix the flagged fields before approving.',
                    result.error.issues,
                );
            }

            const processed = this.warehouseService.applyCreateBusinessRules(result.data);
            // Publishing preserves the last content editor, including on auto-approval.
            processed.lastEditedBy = row.lastEditedBy ?? null;
            // Derive micro-market tags from the coordinates geocoded at submission
            // time, so the promoted warehouse lands already tagged.
            await this.warehouseService.applyMicroMarketTags(processed);
            // Approval couples visibility: approved => not hidden.
            processed.visibility = true;
            // wogVerified is a SEPARATE trust signal with its own process — approval never
            // sets it. It flows through from the staged row (false at ingest).
            // uploadedBy is preserved from the original submission.

            return this.stagedWarehouseModel.promote(id, processed, reviewer, {
                availability: row.availability ?? null,
                availabilityLastReviewedOn: row.availabilityLastReviewedOn ?? null,
            }, row.__editVersion);
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
     * Auto-approve hook for freshly staged rows. When autopilot is on (DB setting,
     * see SettingsService), promote the row immediately and return it as APPROVED
     * with `warehouseId` set to the master Warehouse it produced — that id is what
     * the create endpoints hand back to the submitter.
     *
     * Never fails the submission. The row is already stored by the time we get here,
     * so any problem (setting unreadable, strict validation failure on a partial
     * ingest payload, a promotion hiccup) degrades to "left PENDING for review"
     * rather than erroring out work that was in fact saved.
     * @param {Object} staged - The just-created staged row
     * @returns {Promise<Object>} The staged row (APPROVED + warehouseId if promotion succeeded)
     * @private
     */
    async maybeAutoApprove(staged) {
        let enabled;
        try {
            enabled = await this.settingsService.getAutoApprove();
        } catch (error) {
            console.error('maybeAutoApprove: could not read auto-approve setting, leaving PENDING:', error.message);
            return staged;
        }
        if (!enabled) return staged;

        let warehouse;
        try {
            warehouse = await this.approveSubmission(staged.id, AUTO_APPROVE_REVIEWER);
        } catch (error) {
            // Leave the row for manual review if it can't be auto-approved. This covers
            // strict-validation failures (partial ingest payloads) and promotion failures
            // alike. Re-read because a concurrent reviewer or a connection loss after
            // the atomic commit can leave the row APPROVED despite this request's error.
            // Cold path, so the extra query costs nothing on the hot one — and it falls
            // back to the in-memory row, since the read can fail for the same reason the
            // promotion did.
            console.error(`maybeAutoApprove: could not promote ${staged.id}, leaving unpromoted:`, error.message);
            const current = await this.stagedWarehouseModel.findByStagedId(staged.id).catch(() => null);
            return current || staged;
        }

        // Reflect the promotion locally rather than re-reading the row: the id comes straight
        // off the Warehouse insert, so the submitter's receipt states what was actually
        // created, and the hot submission path drops two queries (the re-read plus its
        // existence annotation).
        // `reviewedAt` is a local approximation of the timestamp promote() wrote; nothing
        // reads it (the receipt drops it), it's set to keep the returned row self-consistent.
        return {
            ...staged,
            reviewStatus: 'APPROVED',
            reviewedBy: AUTO_APPROVE_REVIEWER.email,
            reviewedAt: new Date(),
            warehouseId: warehouse.id,
        };
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
            if (key === 'offeredSpaceSqft') continue;
            if (STAGING_META_FIELDS.has(key)) continue;
            if (WAREHOUSE_DATA_FIELDS.includes(key)) continue;
            warehouse[key] = value;
        }
        if (Object.hasOwn(warehouse, 'scoutVoiceNotes')) warehouse.scoutVoiceNotes = warehouse.scoutVoiceNotes || [];
        return { ...warehouse, warehouseData };
    }

    /**
     * Field-level before/after diff between a staged row and proposed edits.
     *
     * The staged mirror is flat, so no nested handling is needed. Delegates to
     * the shared audit differ, which masks phone-like fields and summarizes
     * oversized values (photos, media, rawPayload) before they reach an audit row.
     * @private
     */
    computeDiff(row, edits) {
        return computeChanges(row, edits);
    }
}

StagingService.WAREHOUSE_DATA_FIELDS = WAREHOUSE_DATA_FIELDS;
StagingService.STAGING_META_FIELDS = STAGING_META_FIELDS;

module.exports = StagingService;
