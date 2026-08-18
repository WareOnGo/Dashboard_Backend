/**
 * Add the PostGIS bits Prisma cannot express, and verify them.
 *
 * Prisma has no geometry types, so `geog` is added here as a GENERATED column
 * derived from lat/lng. Generated (rather than a trigger or an application-set
 * column) means the two can never drift: lat/lng stay the single source of truth
 * and Postgres maintains the geography automatically on every insert and update.
 *
 * Prisma is unaware of the column, which is fine — it ignores unknown columns on
 * read and never writes it. Re-running `prisma db push` will NOT drop it, but
 * `prisma migrate reset` would, so this script is idempotent and safe to re-run.
 *
 * Usage:
 *   node -r dotenv/config scripts/setupGeoColumns.js [--verify]
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const VERIFY_ONLY = process.argv.includes('--verify');

/** Tables that get a generated point geography derived from lat/lng. */
const TABLES = ['osm_poi', 'point_of_interest', 'WarehouseData'];

const ddl = (table) => [
    `ALTER TABLE "${table}"
       ADD COLUMN IF NOT EXISTS geog geography(Point, 4326)
       GENERATED ALWAYS AS (
         CASE WHEN ${table === 'WarehouseData' ? 'longitude IS NOT NULL AND latitude IS NOT NULL' : 'lng IS NOT NULL AND lat IS NOT NULL'}
              THEN ST_SetSRID(ST_MakePoint(${table === 'WarehouseData' ? 'longitude, latitude' : 'lng, lat'}), 4326)::geography
         END
       ) STORED`,
    `CREATE INDEX IF NOT EXISTS "${table}_geog_gist" ON "${table}" USING GIST (geog)`,
];

async function main() {
    if (!VERIFY_ONLY) {
        await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS postgis');
        for (const table of TABLES) {
            for (const stmt of ddl(table)) {
                await prisma.$executeRawUnsafe(stmt);
            }
            console.log(`  ${table}: geog column + GiST index ready`);
        }
    }

    console.log('\n=== verification ===');
    const cols = await prisma.$queryRawUnsafe(`
        SELECT table_name, column_name, is_generated, udt_name
        FROM information_schema.columns
        WHERE column_name = 'geog' AND table_schema = 'public'
        ORDER BY table_name
    `);
    for (const c of cols) {
        console.log(`  ${c.table_name.padEnd(20)} ${c.udt_name}  generated=${c.is_generated}`);
    }

    const idx = await prisma.$queryRawUnsafe(`
        SELECT tablename, indexname FROM pg_indexes
        WHERE schemaname = 'public' AND indexname LIKE '%geog_gist' ORDER BY tablename
    `);
    console.log(`  spatial indexes: ${idx.map((i) => i.indexname).join(', ') || 'none'}`);

    // Prove the generated column actually populates, then leave nothing behind.
    const probe = await prisma.$queryRawUnsafe(`
        SELECT COUNT(*)::int total, COUNT(geog)::int with_geog
        FROM "WarehouseData"
    `);
    console.log(`  WarehouseData: ${probe[0].with_geog}/${probe[0].total} rows have a geography (rest have no coordinates)`);
}

main()
    .catch((err) => { console.error('ERR:', err.message); process.exit(1); })
    .finally(() => prisma.$disconnect());
