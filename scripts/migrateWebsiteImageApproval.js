// Additive migration with before/after hashes of every pre-existing column.
const path = require('node:path');
const fs = require('node:fs');
const { migrate } = require('./migrateImagePipeline');
const migrateWebsiteApproval = (prisma, apply = false) => migrate(prisma, apply, ['imageWebsiteApproval.sql']);
module.exports = { migrateWebsiteApproval };
if (require.main === module) {
    require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
    if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Usage: migrateWebsiteImageApproval.js [--apply]');
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    migrateWebsiteApproval(prisma, process.argv.includes('--apply')).then(report => {
        const directory = path.resolve(__dirname, '../tools/image-pipeline');
        fs.mkdirSync(directory, { recursive: true });
        const file = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-website-schema.json`);
        fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
        console.log(JSON.stringify({ ...report, report: file }));
    }).catch(error => { console.error('Website image migration failed', { code: error.code, name: error.name }); process.exitCode = 1; })
        .finally(() => prisma.$disconnect());
}
