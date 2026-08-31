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

/**
 * osm_highway is a different shape and gets its own DDL.
 *
 * `prisma db push` creates the column as a bare `geography`, which accepts any
 * geometry at any SRID. Tightening it to geography(LineString, 4326) is what stops
 * a stray point or a mis-projected coordinate from being stored and then silently
 * producing a wrong distance. It is NOT generated: unlike the point tables there
 * is no lat/lng to derive it from — the geometry is the source of truth — so
 * scripts/importOsmPois.js writes it with raw SQL.
 *
 * Idempotent: altering a column to the type it already has succeeds and rewrites
 * nothing, and the index uses IF NOT EXISTS.
 */
const LINE_TABLE_DDL = [
    `ALTER TABLE "osm_highway"
       ALTER COLUMN geog TYPE geography(LineString, 4326)
       USING geog::geography(LineString, 4326)`,
    'CREATE INDEX IF NOT EXISTS "osm_highway_geog_gist" ON "osm_highway" USING GIST (geog)',
];

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

        for (const stmt of LINE_TABLE_DDL) {
            await prisma.$executeRawUnsafe(stmt);
        }
        console.log('  osm_highway: LineString geog column + GiST index ready');
    }

    console.log('\n=== verification ===');
    const cols = await prisma.$queryRawUnsafe(`
        SELECT c.table_name, c.is_generated, c.udt_name,
               format_type(a.atttypid, a.atttypmod) AS full_type
        FROM information_schema.columns c
        JOIN pg_attribute a
          ON a.attrelid = format('%I.%I', c.table_schema, c.table_name)::regclass
         AND a.attname = c.column_name
        WHERE c.column_name = 'geog' AND c.table_schema = 'public'
        ORDER BY c.table_name
    `);
    for (const c of cols) {
        console.log(`  ${c.table_name.padEnd(20)} ${c.full_type.padEnd(34)} generated=${c.is_generated}`);
    }

    // The point tables MUST stay generated. A `prisma db pull`/`db push` cycle can
    // silently downgrade one to a plain DEFAULT, which applies only on insert — so
    // an upsert that corrects lat/lng would move the POI and leave its geography at
    // the old location, making every spatial query quietly wrong.
    const shouldBeGenerated = ['WarehouseData', 'osm_poi', 'point_of_interest'];
    const downgraded = cols
        .filter((c) => shouldBeGenerated.includes(c.table_name) && c.is_generated !== 'ALWAYS')
        .map((c) => c.table_name);
    if (downgraded.length) {
        console.error(`  FAIL: geog is no longer GENERATED on ${downgraded.join(', ')} — `
            + 'lat/lng updates will not update the geography');
        process.exitCode = 1;
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

    // osm_highway rows are written by the ingest, not generated, so a row with a
    // null geography is a real defect rather than a row without coordinates.
    const lines = await prisma.$queryRawUnsafe(`
        SELECT COUNT(*)::int total, COUNT(geog)::int with_geog FROM osm_highway
    `);
    console.log(`  osm_highway:   ${lines[0].with_geog}/${lines[0].total} rows have a geography`);
    if (lines[0].total !== lines[0].with_geog) {
        console.error('  FAIL: osm_highway rows exist with no geography — they can never match a query');
        process.exitCode = 1;
    }
}

main()
    .catch((err) => { console.error('ERR:', err.message); process.exit(1); })
    .finally(() => prisma.$disconnect());
