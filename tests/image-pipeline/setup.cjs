const { PrismaClient } = require('@prisma/client');
const testDatabaseUrl = require('../helpers/testDatabaseUrl');
const { migrate } = require('../../scripts/migrateImagePipeline');
const databaseUrl = testDatabaseUrl(process.env.TEST_DATABASE_URL);
const schema = `
CREATE TYPE "ImageClass" AS ENUM ('INDOOR','OUTDOOR','DOCUMENT','UNKNOWN');
CREATE TYPE "DocumentKind" AS ENUM ('LAYOUT','PAPERWORK','OTHER_DOCUMENT','NOT_A_DOCUMENT');
CREATE TABLE "Warehouse" (id serial PRIMARY KEY, media jsonb, photos text, "photosWebp" text, visibility boolean DEFAULT true);
CREATE TABLE labeled_warehouse_images (id serial PRIMARY KEY, "warehouseId" int NOT NULL,
  "imageUrl" text NOT NULL UNIQUE, classification "ImageClass" NOT NULL, description text,
  model text NOT NULL, confidence double precision, "createdAt" timestamp NOT NULL DEFAULT now(), "documentKind" "DocumentKind");
`;
async function main() {
 const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
 try {
  const [exists] = await prisma.$queryRawUnsafe(`SELECT to_regclass('public.labeled_warehouse_images') IS NOT NULL AS exists`);
  if (!exists.exists) {
   for (const sql of schema.split(';').map(s => s.trim()).filter(Boolean)) await prisma.$executeRawUnsafe(sql);
   await prisma.$executeRawUnsafe(`INSERT INTO "Warehouse" (media,photos) VALUES ('{"images":["https://fixture.r2.dev/keep.jpg"],"videos":["https://fixture.r2.dev/keep.mp4"],"docs":[]}', 'https://fixture.r2.dev/keep.jpg')`);
   await prisma.$executeRawUnsafe(`INSERT INTO labeled_warehouse_images ("warehouseId","imageUrl",classification,description,model) VALUES (1,'https://fixture.r2.dev/keep.jpg','INDOOR','Existing caption','legacy')`);
  }
  console.log(JSON.stringify(await migrate(prisma, true)));
  console.log(JSON.stringify({ repeated: await migrate(prisma, true) }));
 } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
