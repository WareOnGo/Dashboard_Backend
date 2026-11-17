/**
 * Split the `JC` uploader label into Jayanth and Deepak.
 *
 * WHY. 302 Warehouse rows carry `uploadedBy = 'JC'`, which is two people sharing a
 * label across a handover, not one person. The split is established from
 * MessageLog: Deepak sent no message before 2026-04-07 and Jayanth none after
 * 2026-05-22, so 233 of the 302 rows are attributable by activity window ALONE —
 * they cannot belong to the other person. The remaining 69 sit in the 45-day
 * overlap and are attributed by nearest message within 15 minutes, which is
 * decisive for 67 of them.
 *
 * Corroboration, from fields the cleanups never touched: the two eras differ
 * sharply in habit — contact names carry a title (Mr/Shri) in 42% of the later set
 * and 0% of the earlier, and `compliances = "NA"` runs 58% vs 26%. Those rates
 * match each person's own email-labelled rows (71% and 33%). Note the fill-rate
 * comparison is NOT usable evidence here: the JC rows and the email-labelled rows
 * come from different intake pipelines, so fill rates measure the form, not the
 * author.
 *
 * The window boundaries are recomputed from MessageLog at run time rather than
 * hardcoded, so this re-derives itself if the log changes. The two overlap rows
 * that had both senders within 15 minutes are listed explicitly below with the
 * reason, because a coin-flip should not hide inside a loop.
 *
 * DEFAULT IS --dry-run.
 *
 *   node -r dotenv/config scripts/splitJcUploader.js
 *   node -r dotenv/config scripts/splitJcUploader.js --apply
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');
const SNAPSHOT = path.join(__dirname, '..', 'tools',
    `jc-split-snapshot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.rollback.sql`);

const JAYANTH = 'jayanth@wareongo.com';
const DEEPAK = 'deepak@wareongo.com';
const WINDOW_MS = 15 * 60 * 1000;

/**
 * The two rows in the overlap with both senders within 15 minutes. Each is decided
 * by two independent signals agreeing: the 0-minute timestamp match, and the
 * compliances="NA" habit marker (58% Deepak, 26% Jayanth).
 */
const TIEBREAK = {
    1564: { to: JAYANTH, why: 'Jayanth 0min vs Deepak 5min; compliances="Available", not the NA habit' },
    1565: { to: DEEPAK, why: 'Deepak 0min vs Jayanth 5min; compliances="NA", the Deepak habit' },
};

/** Counts established during analysis. A mismatch means something moved — stop. */
const EXPECT = { [JAYANTH]: 111, [DEEPAK]: 191 };

const last10 = (p) => String(p).replace(/\D/g, '').slice(-10);

function scriptClient() {
    const url = process.env.DATABASE_URL || '';
    const withLimit = /connection_limit=\d+/.test(url)
        ? url.replace(/connection_limit=\d+/, 'connection_limit=1')
        : url + (url.includes('?') ? '&' : '?') + 'connection_limit=1';
    return new PrismaClient({ datasources: { db: { url: withLimit } } });
}

async function main() {
    const prisma = scriptClient();

    const roster = await prisma.verifiedNumber.findMany({ select: { name: true, email: true, phone_number: true } });
    for (const target of [JAYANTH, DEEPAK]) {
        if (!roster.some((r) => r.email === target)) {
            console.error(`refusing to run: ${target} is not on the VerifiedNumber roster`);
            await prisma.$disconnect();
            process.exit(1);
        }
    }
    const numFor = (name) => last10(roster.find((r) => r.name === name).phone_number);

    const msgs = await prisma.messageLog.findMany({ select: { sender_number: true, received_at: true } });
    const timesFor = (digits) => msgs.filter((m) => last10(m.sender_number) === digits)
        .map((m) => m.received_at).sort((a, b) => a - b);
    const jT = timesFor(numFor('Jayanth'));
    const dT = timesFor(numFor('Deepak'));
    if (!jT.length || !dT.length) {
        console.error('refusing to run: no MessageLog activity for one of the two senders');
        await prisma.$disconnect();
        process.exit(1);
    }
    const overlapStart = dT[0];
    const overlapEnd = jT[jT.length - 1];
    const day = (d) => d.toISOString().slice(0, 10);
    console.log(`Jayanth active ${day(jT[0])}..${day(overlapEnd)}   Deepak active ${day(overlapStart)}..${day(dT[dT.length - 1])}`);
    console.log(`overlap ${day(overlapStart)}..${day(overlapEnd)}\n`);

    const nearest = (arr, d) => arr.reduce((best, t) => Math.min(best, Math.abs(t - d)), Infinity);

    const rows = await prisma.warehouse.findMany({
        where: { uploadedBy: 'JC' }, select: { id: true, createdAt: true }, orderBy: { createdAt: 'asc' },
    });
    const changes = [];
    const reasons = { windowJ: 0, windowD: 0, proxJ: 0, proxD: 0, tie: 0, unresolved: [] };

    for (const w of rows) {
        const d = w.createdAt;
        if (d < overlapStart) { changes.push({ id: w.id, to: JAYANTH }); reasons.windowJ++; continue; }
        if (d > overlapEnd) { changes.push({ id: w.id, to: DEEPAK }); reasons.windowD++; continue; }
        const nj = nearest(jT, d);
        const nd = nearest(dT, d);
        if (nj < WINDOW_MS && nd >= WINDOW_MS) { changes.push({ id: w.id, to: JAYANTH }); reasons.proxJ++; continue; }
        if (nd < WINDOW_MS && nj >= WINDOW_MS) { changes.push({ id: w.id, to: DEEPAK }); reasons.proxD++; continue; }
        const t = TIEBREAK[w.id];
        if (t) { changes.push({ id: w.id, to: t.to, why: t.why }); reasons.tie++; continue; }
        reasons.unresolved.push(w.id);
    }

    console.log('=== attribution ===');
    console.log(`  window-exclusive -> Jayanth  ${String(reasons.windowJ).padStart(4)}   (Deepak not yet active)`);
    console.log(`  window-exclusive -> Deepak   ${String(reasons.windowD).padStart(4)}   (Jayanth no longer active)`);
    console.log(`  overlap, only Jayanth <15min ${String(reasons.proxJ).padStart(4)}`);
    console.log(`  overlap, only Deepak  <15min ${String(reasons.proxD).padStart(4)}`);
    console.log(`  named tiebreak               ${String(reasons.tie).padStart(4)}`);
    for (const [id, t] of Object.entries(TIEBREAK)) console.log(`      ${id} -> ${t.to}  (${t.why})`);
    if (reasons.unresolved.length) {
        console.error(`\nrefusing to run: ${reasons.unresolved.length} rows are ambiguous and unnamed: ${reasons.unresolved.join(', ')}`);
        console.error('add them to TIEBREAK with a reason, or re-check the analysis.');
        await prisma.$disconnect();
        process.exit(1);
    }

    const tally = {};
    for (const c of changes) tally[c.to] = (tally[c.to] || 0) + 1;
    console.log(`\n=== totals ===`);
    for (const [k, v] of Object.entries(tally)) {
        const ok = EXPECT[k] === v;
        console.log(`  ${k.padEnd(24)} ${String(v).padStart(4)}   expected ${EXPECT[k]}  ${ok ? 'OK' : '<<< MISMATCH'}`);
    }
    if (Object.entries(EXPECT).some(([k, v]) => tally[k] !== v)) {
        console.error('\nrefusing to run: attribution no longer matches the reviewed counts.');
        await prisma.$disconnect();
        process.exit(1);
    }

    if (!APPLY) {
        console.log('\ndry-run: nothing written. Re-run with --apply to write.');
        await prisma.$disconnect();
        return;
    }

    if (fs.existsSync(SNAPSHOT)) {
        console.error(`refusing to overwrite an existing rollback file: ${SNAPSHOT}`);
        await prisma.$disconnect();
        process.exit(1);
    }
    fs.writeFileSync(SNAPSHOT, changes.map((c) => `UPDATE "Warehouse" SET "uploadedBy"='JC' WHERE "id"=${c.id};`).join('\n') + '\n');
    console.log(`\nrollback SQL -> ${SNAPSHOT}`);

    // Raw SQL: `status_updated_at` is @updatedAt and is shown to users as
    // "Status Updated At". Correcting an attribution label is not a status change.
    let written = 0;
    for (const target of [JAYANTH, DEEPAK]) {
        const ids = changes.filter((c) => c.to === target).map((c) => c.id);
        const n = await prisma.$executeRawUnsafe(
            'UPDATE "Warehouse" SET "uploadedBy" = $1 WHERE "id" = ANY($2::int[])', target, ids);
        written += n;
        console.log(`  ${target.padEnd(24)} ${n}`);
    }
    console.log(`\nwritten: ${written} rows`);

    const left = await prisma.warehouse.count({ where: { uploadedBy: 'JC' } });
    console.log(`rows still labelled JC: ${left}`);
    await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
