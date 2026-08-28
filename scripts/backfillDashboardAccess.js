/**
 * Grant VerifiedNumber.dashboardAccess to everyone who already uses the dashboard.
 *
 * This is the first half of turning on the DASHBOARD capability. The column exists
 * and is resolved by utils/access.js, but nothing gates on it yet — and it is set on
 * nobody. Enabling `requireAccess(CAPS.DASHBOARD)` before this runs would 403 every
 * non-admin, which is exactly what happened when the PPT routes briefly required it
 * (see the comment in src/routes/ppt.js and tests/routes/pptAccess.test.js).
 *
 * So the order is: run this, verify the roster in the admin panel, and only then
 * deploy the gates. This script is idempotent — rows that already have the flag are
 * left alone — so it is safe to re-run before the cutover.
 *
 * Inactive rows are deliberately skipped: `is_active: false` is how someone is
 * offboarded, and granting them access would undo that.
 *
 * Usage:
 *   node scripts/backfillDashboardAccess.js [--dry-run] [--include-inactive]
 *     --dry-run           report what would change, write nothing
 *     --include-inactive  also grant to deactivated rows (not recommended)
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes('--dry-run');
const INCLUDE_INACTIVE = process.argv.includes('--include-inactive');

async function main() {
    const where = { dashboardAccess: false };
    if (!INCLUDE_INACTIVE) where.is_active = true;

    const candidates = await prisma.verifiedNumber.findMany({
        where,
        select: { id: true, name: true, email: true, is_active: true, adminAccess: true },
        orderBy: { name: 'asc' },
    });

    const total = await prisma.verifiedNumber.count();
    const alreadyGranted = await prisma.verifiedNumber.count({ where: { dashboardAccess: true } });
    const skippedInactive = INCLUDE_INACTIVE
        ? 0
        : await prisma.verifiedNumber.count({ where: { dashboardAccess: false, is_active: false } });

    console.log(`Roster: ${total} row(s) | ${alreadyGranted} already have dashboardAccess`);
    console.log(`To grant: ${candidates.length}${skippedInactive ? ` | skipping ${skippedInactive} inactive row(s)` : ''}`);

    // A row with no email can never be matched by resolveCapabilities (it looks up
    // by the OAuth email), so the flag is inert there. Worth surfacing rather than
    // silently granting something that will never take effect.
    const withoutEmail = candidates.filter((r) => !r.email);
    if (withoutEmail.length) {
        console.warn(
            `\n  ${withoutEmail.length} row(s) have no email and can never sign in; ` +
            'the flag will have no effect for them:'
        );
        for (const r of withoutEmail.slice(0, 10)) console.warn(`    - ${r.name} (id ${r.id})`);
        if (withoutEmail.length > 10) console.warn(`    … and ${withoutEmail.length - 10} more`);
    }

    console.log('');
    for (const r of candidates.slice(0, 30)) {
        console.log(`  ${(r.email || '(no email)').padEnd(36)} ${r.name}`);
    }
    if (candidates.length > 30) console.log(`  … and ${candidates.length - 30} more`);

    if (DRY_RUN) {
        console.log('\nDry run — nothing written.');
        return;
    }
    if (!candidates.length) {
        console.log('\nNothing to do.');
        return;
    }

    const res = await prisma.verifiedNumber.updateMany({
        where: { id: { in: candidates.map((r) => r.id) } },
        data: { dashboardAccess: true },
    });
    console.log(`\nDone. Granted dashboardAccess to ${res.count} employee(s).`);
    console.log('Next: verify the roster in the admin panel before deploying the DASHBOARD gates.');
}

main()
    .catch((err) => {
        console.error('Backfill failed:', err);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
