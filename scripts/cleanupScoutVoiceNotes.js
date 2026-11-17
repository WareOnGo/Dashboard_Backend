// Schedule daily. Only expired, unreferenced assets are deleted.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const VoiceNoteService = require('../src/services/voiceNoteService');
const prisma = new PrismaClient();
new VoiceNoteService(prisma).cleanup()
    .then(result => {
        console.log(JSON.stringify(result));
        if (result.failed) process.exitCode = 1;
    })
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
