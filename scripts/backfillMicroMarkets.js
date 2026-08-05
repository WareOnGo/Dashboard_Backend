/**
 * Reconcile Warehouse.micromarket against the reviewer-drawn micro_market polygons.
 *
 * New and edited warehouses are tagged inline the moment their coordinates are
 * known (WarehouseService.applyMicroMarketTags), so this script is NOT the
 * primary mechanism — it exists for the two cases inline tagging can't cover:
 *   - the original backfill of rows that predate the feature
 *   - re-tagging everything after polygons are added, moved, or renamed
 *     (tags are stored as names, so a rename needs `--all` to propagate)
 *
 * A warehouse's coordinates live on WarehouseData (latitude/longitude). For each
 * geocoded warehouse we test its point against every polygon and store the names
 * of the ones that contain it. The column is a String[] because polygons can and
 * do overlap, so a site may legitimately belong to more than one micro-market.
 *
 * Polygons with a blank name fall back to their id so the tag is never empty.
 *
 * Usage:
 *   node scripts/backfillMicroMarkets.js [--dry-run] [--all]
 *     --dry-run  report what would change, write nothing
 *     --all      also recompute warehouses that already have a tag
 *                (default: only rows whose micromarket is currently empty)
 */
const { PrismaClient } = require('@prisma/client');
const { resolveTags, isSupported } = require('../src/utils/microMarketGeometry');

const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes('--dry-run');
const ALL = process.argv.includes('--all');

const sameSet = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

async function main() {
    const markets = await prisma.microMarket.findMany({
        select: { id: true, name: true, city: true, geometry: true },
    });

    const unsupported = markets.filter((m) => !isSupported(m.geometry));
    if (unsupported.length) {
        console.warn(
            `Skipping ${unsupported.length} polygon(s) with unsupported geometry:`,
            unsupported.map((m) => `${m.name || m.id} (${m.geometry?.type})`).join(', ')
        );
    }
    console.log(`Loaded ${markets.length} micro-market polygon(s).`);

    const warehouses = await prisma.warehouse.findMany({
        where: ALL ? {} : { micromarket: { isEmpty: true } },
        select: {
            id: true,
            city: true,
            micromarket: true,
            WarehouseData: { select: { latitude: true, longitude: true } },
        },
    });
    console.log(`Scanning ${warehouses.length} warehouse(s)${ALL ? '' : ' with an empty tag'}.`);

    let noCoords = 0;
    let unmatched = 0;
    let unchanged = 0;
    // Group by the resulting tag set so N warehouses collapse into a handful of
    // updateMany calls instead of N round-trips through the pooler.
    const batches = new Map();

    for (const w of warehouses) {
        const lat = w.WarehouseData?.latitude;
        const lon = w.WarehouseData?.longitude;
        if (lat == null || lon == null) {
            noCoords++;
            continue;
        }

        const tags = resolveTags(markets, lat, lon);

        if (!tags.length) {
            unmatched++;
            continue;
        }
        if (sameSet(tags, [...w.micromarket].sort())) {
            unchanged++;
            continue;
        }

        const key = JSON.stringify(tags);
        if (!batches.has(key)) batches.set(key, { tags, ids: [] });
        batches.get(key).ids.push(w.id);
    }

    const toUpdate = [...batches.values()].reduce((n, b) => n + b.ids.length, 0);
    console.log(
        `\n  ${toUpdate} to tag | ${unchanged} already correct | ${unmatched} outside every polygon | ${noCoords} without coordinates`
    );

    const preview = [...batches.values()].sort((a, b) => b.ids.length - a.ids.length);
    for (const b of preview.slice(0, 25)) {
        console.log(`  ${b.tags.join(' + ').padEnd(40)} → ${b.ids.length} warehouse(s)`);
    }
    if (preview.length > 25) console.log(`  … and ${preview.length - 25} more tag set(s)`);

    if (DRY_RUN) {
        console.log('\nDry run — nothing written.');
        return;
    }

    let written = 0;
    for (const { tags, ids } of batches.values()) {
        const res = await prisma.warehouse.updateMany({
            where: { id: { in: ids } },
            data: { micromarket: tags },
        });
        written += res.count;
    }
    console.log(`\nDone. Updated ${written} warehouse(s).`);
}

main()
    .catch((err) => {
        console.error('Backfill failed:', err);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());

