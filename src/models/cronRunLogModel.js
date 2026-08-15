// src/models/cronRunLogModel.js
const BaseModel = require('./baseModel');

/**
 * CronRunLogModel — persistence for cron_run_log (see prisma/schema.prisma
 * CronRunLog). One row per scheduled-job invocation.
 *
 * Doubles as the concurrency guard for jobs triggered over HTTP. An in-process
 * lock is not enough: App Runner can run more than one container, so two cron
 * pokes could otherwise sweep the same images at the same time. Correctness is
 * safe either way (createMany skipDuplicates), but duplicate work costs real
 * money in API calls, so the guard lives in the database where all instances
 * can see it.
 */
class CronRunLogModel extends BaseModel {
    constructor(prismaClient = null) {
        super(prismaClient);
        this.model = this.prisma.cronRunLog;
    }

    /**
     * Is a run of this job currently in flight and still fresh?
     *
     * A RUNNING row older than `staleAfterMs` is treated as abandoned (the
     * container died mid-run and never wrote a terminal status), so a crash can
     * never wedge the job permanently.
     *
     * @param {string} jobName
     * @param {number} staleAfterMs - Age past which a RUNNING row is ignored
     * @returns {Promise<Object|null>} The in-flight row, or null
     */
    async findInFlight(jobName, staleAfterMs) {
        try {
            return await this.model.findFirst({
                where: {
                    jobName,
                    status: 'RUNNING',
                    ranAt: { gte: new Date(Date.now() - staleAfterMs) },
                },
                orderBy: { ranAt: 'desc' },
            });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Open a run, returning the row so it can be finished later.
     * @param {string} jobName
     * @param {Object} [metadata]
     * @returns {Promise<Object>}
     */
    async start(jobName, metadata = null) {
        try {
            return await this.model.create({
                data: { jobName, status: 'RUNNING', durationMs: 0, metadata },
            });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Close a run with its terminal status.
     * @param {bigint|number} id
     * @param {string} status - SUCCESS | FAILED | SKIPPED
     * @param {number} durationMs
     * @param {Object} [metadata]
     * @param {string} [notes]
     * @returns {Promise<Object>}
     */
    async finish(id, status, durationMs, metadata = null, notes = null) {
        try {
            return await this.model.update({
                where: { id },
                data: { status, durationMs, metadata, notes },
            });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Recent runs of a job, newest first.
     * @param {string} jobName
     * @param {number} [limit]
     * @returns {Promise<Array<Object>>}
     */
    async recent(jobName, limit = 10) {
        try {
            return await this.model.findMany({
                where: { jobName },
                orderBy: { ranAt: 'desc' },
                take: limit,
            });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }
}

module.exports = CronRunLogModel;
