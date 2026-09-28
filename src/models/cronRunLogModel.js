const BaseModel = require('./baseModel');

// Read enrichment history for the dashboard; run creation belongs to the worker.
class CronRunLogModel extends BaseModel {
    constructor(prismaClient = null) {
        super(prismaClient);
        this.model = this.prisma.cronRunLog;
    }

    async bounded(operation) {
        return this.prisma.$transaction(async tx => {
            await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
            return operation(tx.cronRunLog);
        }, { maxWait: 3000, timeout: 8000 });
    }

    /**
     * Recent runs of a job, newest first.
     * @param {string} jobName
     * @param {number} [limit]
     * @returns {Promise<Array<Object>>}
     */
    async recent(jobName, limit = 10) {
        try {
            return await this.bounded(model => model.findMany({
                where: { jobName },
                orderBy: { ranAt: 'desc' },
                take: limit,
            }));
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }
}

module.exports = CronRunLogModel;
