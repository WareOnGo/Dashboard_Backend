// Additive JPEG-only migration. The shared helper verifies every existing value.
const path = require('node:path');
const fs = require('node:fs');
const { migrate } = require('./migrateImagePipeline');
const migrateJpeg = (prisma, apply = false) => migrate(prisma, apply, ['imageJpegVariant.sql']);
module.exports = { migrateJpeg };

if (require.main === module) {
    require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--apply')) throw new Error('Usage: node scripts/migrateImageJpeg.js [--apply]');
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    migrateJpeg(prisma, args.includes('--apply')).then(report => {
        const directory = path.resolve(__dirname, '../tools/image-pipeline');
        fs.mkdirSync(directory, { recursive: true });
        const file = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-jpeg-schema.json`);
        fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
        console.log(JSON.stringify({ ...report, report: file }));
    }).catch(error => {
        console.error('JPEG migration failed', { code: error.code, name: error.name });
        process.exitCode = 1;
    }).finally(() => prisma.$disconnect());
}
