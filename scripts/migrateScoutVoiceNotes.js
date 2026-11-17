// Inspect by default. Apply only this feature's additive DDL with --apply.
const fs = require('node:fs');
const path = require('node:path');

const assetColumns = {
    id: ['text', 'NO'], scoutId: ['integer', 'NO'], clientRecordingId: ['text', 'NO'],
    draftId: ['text', 'NO'], uploadKey: ['text', 'NO'], storageKey: ['text', 'YES'],
    contentType: ['text', 'NO'], expectedSize: ['integer', 'NO'], sizeBytes: ['integer', 'YES'],
    durationMs: ['integer', 'YES'], state: ['text', 'NO'], operationToken: ['text', 'YES'],
    leaseUntil: ['timestamp without time zone', 'YES'], expiresAt: ['timestamp without time zone', 'NO'],
    createdAt: ['timestamp without time zone', 'NO'], updatedAt: ['timestamp without time zone', 'NO'],
};

async function inspect(prisma) {
    const rows = await prisma.$queryRaw`
        SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND
          ((table_name IN ('Warehouse', 'StagedWarehouse') AND column_name IN ('id', 'scoutVoiceNotes'))
           OR table_name = 'ScoutVoiceNoteAsset')
        ORDER BY table_name, ordinal_position
    `;
    for (const table of ['Warehouse', 'StagedWarehouse']) {
        if (!rows.some(row => row.table_name === table && row.column_name === 'id')) {
            throw new Error('Missing expected public.' + table + ' table');
        }
        const column = rows.find(row => row.table_name === table && row.column_name === 'scoutVoiceNotes');
        if (column && (column.data_type !== 'jsonb' || column.column_default !== "'[]'::jsonb"
            || column.is_nullable !== (table === 'Warehouse' ? 'NO' : 'YES'))) {
            throw new Error('Unexpected definition for ' + table + '.scoutVoiceNotes');
        }
    }
    const assets = rows.filter(row => row.table_name === 'ScoutVoiceNoteAsset');
    if (assets.length) for (const [name, [type, nullable]] of Object.entries(assetColumns)) {
        const column = assets.find(row => row.column_name === name);
        if (!column || column.data_type !== type || column.is_nullable !== nullable) {
            throw new Error('Unexpected definition for ScoutVoiceNoteAsset.' + name);
        }
    }
    const indexes = await prisma.$queryRaw`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'ScoutVoiceNoteAsset'
        ORDER BY indexname
    `;
    const security = await prisma.$queryRaw`
        SELECT c.relrowsecurity AS rls_enabled,
          (r.rolsuper OR r.rolbypassrls OR (c.relowner = r.oid AND NOT c.relforcerowsecurity)) AS server_bypasses_rls,
          has_table_privilege(c.oid, 'SELECT') AS can_select,
          has_table_privilege(c.oid, 'INSERT') AS can_insert,
          has_table_privilege(c.oid, 'UPDATE') AS can_update,
          has_table_privilege(c.oid, 'DELETE') AS can_delete
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_roles r ON r.rolname = current_user
        WHERE n.nspname = 'public' AND c.relname = 'ScoutVoiceNoteAsset'
    `;
    return { columns: rows.filter(row => row.table_name === 'ScoutVoiceNoteAsset' || row.column_name === 'scoutVoiceNotes'), indexes, security };
}

async function migrate(prisma, apply = false) {
    const before = await inspect(prisma);
    if (!apply) return { mode: 'inspect', ...before };
    const sql = fs.readFileSync(path.join(__dirname, 'sql/scoutVoiceNotes.sql'), 'utf8');
    const statements = sql.split('-- statement-breakpoint').map(statement => statement.trim()).filter(Boolean);
    // Keep lock waits short on the live tables. Array transactions also work
    // through the configured transaction pooler without session assumptions.
    await prisma.$transaction([
        prisma.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'"),
        prisma.$executeRawUnsafe("SET LOCAL statement_timeout = '20s'"),
        ...statements.map(statement => prisma.$executeRawUnsafe(statement)),
    ]);
    const after = await inspect(prisma);
    if (after.columns.length !== Object.keys(assetColumns).length + 2) throw new Error('Voice-note column verification failed');
    for (const name of ['ScoutVoiceNoteAsset_pkey', 'ScoutVoiceNoteAsset_scoutId_clientRecordingId_key', 'ScoutVoiceNoteAsset_state_expiresAt_idx']) {
        if (!after.indexes.some(index => index.indexname === name)) throw new Error('Missing voice-note index: ' + name);
    }
    if (!after.security[0] || Object.values(after.security[0]).some(value => value !== true)) {
        throw new Error('Voice-note RLS or server database access verification failed');
    }
    return { mode: 'applied', ...after };
}
module.exports = { migrate };
if (require.main === module) {
    require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    migrate(prisma, process.argv.includes('--apply'))
        .then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(error => {
            console.error('Voice-note migration failed', {
                name: error.name, code: error.code || error.errorCode,
                ...(error.name === 'Error' ? { message: error.message } : {}),
            });
            process.exitCode = 1;
        })
        .finally(() => prisma.$disconnect());
}
