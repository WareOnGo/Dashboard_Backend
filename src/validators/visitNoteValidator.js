// src/validators/visitNoteValidator.js
const { z } = require('zod');
const BaseValidator = require('./baseValidator');

/**
 * Visit-note validation schemas.
 * visitDate accepts "YYYY-MM-DD" (or any ISO date string) and is transformed
 * to a Date so it can be passed straight to Prisma's @db.Date column.
 */
class VisitNoteValidator extends BaseValidator {
    static visitDateSchema = z
        .string()
        .min(1, "visitDate is required")
        .refine((v) => !Number.isNaN(Date.parse(v)), "visitDate must be a valid date")
        .transform((v) => new Date(v));

    /**
     * Schema for creating a visit note
     */
    static createVisitNoteSchema = z.object({
        client: z.string().min(1, "client is required"),
        clientPoc: z.string().optional().nullable(),
        wareOnGoPoc: z.string().optional().nullable(),
        visitDate: this.visitDateSchema,
        clientFeedback: z.string().optional().nullable(),
        pocFeedback: z.string().optional().nullable(),
    });

    /**
     * Schema for updating a visit note (all fields optional)
     */
    static updateVisitNoteSchema = z.object({
        client: z.string().min(1, "client cannot be empty").optional(),
        clientPoc: z.string().optional().nullable(),
        wareOnGoPoc: z.string().optional().nullable(),
        visitDate: this.visitDateSchema.optional(),
        clientFeedback: z.string().optional().nullable(),
        pocFeedback: z.string().optional().nullable(),
    });
}

module.exports = VisitNoteValidator;
