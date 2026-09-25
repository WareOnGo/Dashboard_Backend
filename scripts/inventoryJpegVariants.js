const path = require('node:path');
const fs = require('node:fs/promises');
const root = path.resolve(__dirname, '..');
const args=process.argv.slice(2);
if(args.length>1||args.some(arg=>!arg.startsWith('--output=')))throw new Error('Usage: inventoryJpegVariants.js [--output=path]');
const output=args[0]?path.resolve(args[0].slice(9)):path.join(root,'tools/image-pipeline/jpeg-backfill-1280-inventory.json');
require(path.join(root, 'node_modules/dotenv')).config({path:path.join(root,'.env'),quiet:true});
const { PrismaClient } = require(path.join(root,'node_modules/@prisma/client'));
const { S3Client,ListObjectsV2Command } = require(path.join(root,'node_modules/@aws-sdk/client-s3'));
const { sourceTarget } = require(path.join(root,'scripts/lib/imageCompressionBackfill'));
const prisma = new PrismaClient();
const s3 = new S3Client({region:'auto',endpoint:`https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
 credentials:{accessKeyId:process.env.R2_ACCESS_KEY_ID,secretAccessKey:process.env.R2_SECRET_ACCESS_KEY},maxAttempts:2});
(async()=>{
 const rows = await prisma.$queryRawUnsafe(`WITH refs AS (
   SELECT w.id,unnest(public.wareongo_image_urls(w.media::jsonb,w.photos)) AS url FROM "Warehouse" w
 ) SELECT l.id,l."imageUrl",l.classification::text AS classification,l."documentKind"::text AS "documentKind",
 l."jpegUrl",l."jpegVersion",l."jpegStatus",l."jpegBytes"::text AS "jpegBytes",l."jpegAt",
 array_agg(DISTINCT refs.id ORDER BY refs.id) AS "warehouseIds"
 FROM refs LEFT JOIN labeled_warehouse_images l ON refs.url=l."imageUrl" GROUP BY l.id ORDER BY l.id`);
 const warehouses = await prisma.$queryRawUnsafe(`SELECT id,md5(to_jsonb(w)::text) AS digest FROM "Warehouse" w ORDER BY id`);
 const images = await prisma.$queryRawUnsafe(`SELECT id,md5((to_jsonb(l)-ARRAY['jpegUrl','jpegBytes','jpegAt','jpegVersion','jpegStatus','jpegError'])::text) AS digest FROM labeled_warehouse_images l ORDER BY id`);
 const inventory = new Map();let token;let pages=0;const seen=new Set();
 do {const page=await s3.send(new ListObjectsV2Command({Bucket:process.env.R2_BUCKET_NAME,MaxKeys:1000,ContinuationToken:token}),{abortSignal:AbortSignal.timeout(30000)});
  for(const o of page.Contents||[]) inventory.set(o.Key,{bytes:Number(o.Size),etag:o.ETag,modifiedAt:o.LastModified});
  pages++;const next=page.IsTruncated?page.NextContinuationToken:undefined;
  if(page.IsTruncated&&(!next||seen.has(next))) throw Error('incomplete_inventory');if(next)seen.add(next);token=next;
 }while(token);
 for(const row of rows){const target=sourceTarget(row.imageUrl,process.env.R2_PUBLIC_URL);row.originalKey=target?.originalKey;row.object=inventory.get(target?.originalKey)||null;}
 const summary={rows:rows.length,unregistered:rows.filter(r=>!r.id).length,drawingsAndDocuments:rows.filter(r=>r.classification==='DOCUMENT').length,
  existingReady:rows.filter(r=>r.jpegStatus==='READY').length,smallCandidates:rows.filter(r=>r.object?.bytes>0&&r.object.bytes<=200*1024).length,
  sourceMissing:rows.filter(r=>!r.object).length,sourceBytes:rows.reduce((n,r)=>n+(r.object?.bytes||0),0),objects:inventory.size,pages};
 const file=output;
 await fs.writeFile(file,JSON.stringify({createdAt:new Date().toISOString(),publicBase:process.env.R2_PUBLIC_URL,bucket:process.env.R2_BUCKET_NAME,summary,rows,warehouses,images},null,2)+'\n',{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({...summary,file}));
})().catch(e=>{console.error({name:e.name,code:e.code,reason:e.message.split('\n')[0]});process.exitCode=1;}).finally(async()=>{await prisma.$disconnect();s3.destroy();});
