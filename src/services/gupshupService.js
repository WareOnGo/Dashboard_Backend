// src/services/gupshupService.js
//
// Gupshup WhatsApp notifications for warehouse review outcomes.
//
// When a reviewer approves or rejects a staged submission, the employee who
// submitted it gets a WhatsApp template message with the outcome. The whole
// feature sits behind config.gupshup.enabled (env GUPSHUP_ENABLED) and is OFF
// until the review flow goes live.
//
// Everything here is BEST-EFFORT: a disabled flag, a missing recipient, or a
// Gupshup outage must never break an approve/reject. The public entry point
// (notifyReviewDecision) never throws — it returns a small result object the
// controller surfaces to the reviewer.
//
// Template params (ordered) match the approved utility template:
//   [ employeeName, finalId, status, comment ]
// e.g. ["Nagaraj", "1923", "Approved", "WH Entry Satisfactory"]

const { config } = require('../utils/config');
const database = require('../utils/database');

/**
 * Notification result returned to the controller.
 * @typedef {Object} NotifyResult
 * @property {boolean} sent       - true only when Gupshup accepted the message
 * @property {('sent'|'disabled'|'skipped'|'failed')} status
 * @property {string} [reason]    - human-readable note when not sent (skipped/failed)
 * @property {string} [messageId] - Gupshup message id when sent
 */

/**
 * Normalize a stored phone number to an E.164-without-plus string for Gupshup
 * (e.g. "918076708542"). Indian-number friendly: bare 10-digit numbers get a
 * 91 prefix, a leading 0 or +91 is handled. Returns null if it can't form a
 * plausible number, so the caller skips rather than sends junk.
 * @param {string} raw
 * @returns {string|null}
 */
function normalizePhone(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let digits = raw.replace(/\D/g, '');
    if (!digits) return null;

    // Strip a domestic trunk-zero prefix (e.g. "08076...").
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);

    // Bare 10-digit Indian mobile → prepend country code.
    if (digits.length === 10) digits = `91${digits}`;

    // Anything shorter than a full national number is not dialable.
    if (digits.length < 11) return null;

    return digits;
}

/**
 * Build the "which submission" label sent as the finalId param. Approvals show
 * the master Warehouse id plus city + sqft + owner (e.g.
 * "#1923, Whitefield, 50000 sqft, Nagaraj"); rejections have no warehouse, so
 * they show "City, N sqft, Owner". All parts are comma-separated and any missing
 * piece is dropped.
 * @param {('APPROVED'|'REJECTED')} outcome
 * @param {Object} row - staged warehouse row
 * @param {number|string} [warehouseId] - master Warehouse id (approvals only)
 * @returns {string}
 */
function buildFinalIdLabel(outcome, row, warehouseId) {
    const city = (row.city || '').trim();
    const sqft = (row.offeredSpaceSqft || (Array.isArray(row.totalSpaceSqft) ? row.totalSpaceSqft.join('/') : '') || '')
        .toString()
        .trim();
    const owner = (row.contactPerson || row.ownerCompanyName || '').trim();

    const parts = [];
    if (outcome === 'APPROVED' && warehouseId != null) parts.push(`#${warehouseId}`);
    if (city) parts.push(city);
    if (sqft) parts.push(`${sqft} sqft`);
    if (owner) parts.push(owner);

    if (parts.length) return parts.join(', ');
    if (outcome === 'APPROVED' && warehouseId != null) return String(warehouseId);
    return 'your submission';
}

/**
 * Resolve the submitter's WhatsApp recipient from the staged row.
 *
 * `submittedBy` is an email for DASHBOARD submissions and email-or-name for
 * SCOUT ones, so we match VerifiedNumber by email first (case-insensitive),
 * then by name as a fallback. Only active numbers are eligible.
 * @param {string} submittedBy
 * @returns {Promise<{ name: string, phone: string }|null>}
 */
async function resolveRecipient(submittedBy) {
    if (!submittedBy || typeof submittedBy !== 'string') return null;
    const value = submittedBy.trim();
    if (!value) return null;

    const prisma = database.getClient();
    const select = { name: true, phone_number: true };

    let row = await prisma.verifiedNumber.findFirst({
        where: { email: { equals: value, mode: 'insensitive' }, is_active: true },
        select,
    });
    if (!row) {
        row = await prisma.verifiedNumber.findFirst({
            where: { name: { equals: value, mode: 'insensitive' }, is_active: true },
            select,
        });
    }
    if (!row) return null;

    const phone = normalizePhone(row.phone_number);
    if (!phone) return null;

    return { name: row.name || 'there', phone };
}

/**
 * Low-level send of a single template message. Resolves to a NotifyResult and
 * never throws — network/HTTP failures come back as { sent:false }.
 * @param {{ destination: string, params: string[] }} args
 * @returns {Promise<NotifyResult>}
 */
async function sendTemplate({ destination, params }) {
    const { apiKey, endpoint, source, srcName, templateId } = config.gupshup;

    const body = new URLSearchParams({
        channel: 'whatsapp',
        source,
        'src.name': srcName,
        destination,
        template: JSON.stringify({ id: templateId, params }),
    });

    let resp;
    try {
        resp = await fetch(endpoint, {
            method: 'POST',
            headers: {
                apikey: apiKey,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cache-Control': 'no-cache',
            },
            body,
        });
    } catch (err) {
        console.error('gupshupService: send failed (network):', err.message);
        return { sent: false, status: 'failed', reason: 'WhatsApp send failed (network error)' };
    }

    let payload = null;
    try {
        payload = await resp.json();
    } catch {
        // Non-JSON body; treat as failure below.
    }

    const ok = resp.ok && payload && payload.status === 'submitted';
    if (!ok) {
        const detail = (payload && (payload.message || payload.status)) || `HTTP ${resp.status}`;
        console.error('gupshupService: send not accepted:', detail);
        return { sent: false, status: 'failed', reason: `WhatsApp send rejected (${detail})` };
    }

    return { sent: true, status: 'sent', messageId: payload.messageId };
}

/**
 * Notify the submitter of a review decision over WhatsApp. Safe to call on
 * every approve/reject — it self-gates on the feature flag and config, resolves
 * the recipient, and swallows all errors.
 *
 * @param {Object} args
 * @param {('APPROVED'|'REJECTED')} args.outcome
 * @param {Object} args.row - the staged warehouse row (needs submittedBy, city, sqft, rejectionReason)
 * @param {number|string} [args.warehouseId] - master Warehouse id (approvals)
 * @returns {Promise<NotifyResult>}
 */
async function notifyReviewDecision({ outcome, row, warehouseId }) {
    try {
        const { enabled, apiKey, source, srcName, templateId } = config.gupshup;

        // Feature flag off → silent no-op (the controller ignores 'disabled').
        if (!enabled) return { sent: false, status: 'disabled' };

        if (!apiKey || !source || !srcName || !templateId) {
            console.error('gupshupService: enabled but missing config (apiKey/source/srcName/templateId)');
            return { sent: false, status: 'skipped', reason: 'WhatsApp not configured' };
        }

        const recipient = await resolveRecipient(row.submittedBy);
        if (!recipient) {
            return {
                sent: false,
                status: 'skipped',
                reason: `No active WhatsApp number on file for the submitter (${row.submittedBy || 'unknown'})`,
            };
        }

        const statusLabel = outcome === 'APPROVED' ? 'Approved' : 'Rejected';
        const comment = outcome === 'APPROVED'
            ? config.gupshup.approveComment
            : (row.rejectionReason || '');

        const params = [
            recipient.name,
            buildFinalIdLabel(outcome, row, warehouseId),
            statusLabel,
            comment,
        ];

        return await sendTemplate({ destination: recipient.phone, params });
    } catch (err) {
        // Last-resort guard: a notification must never break a review.
        console.error('gupshupService: notifyReviewDecision crashed:', err.message);
        return { sent: false, status: 'failed', reason: 'WhatsApp notification error' };
    }
}

module.exports = {
    notifyReviewDecision,
    // exported for unit testing
    normalizePhone,
    buildFinalIdLabel,
};
