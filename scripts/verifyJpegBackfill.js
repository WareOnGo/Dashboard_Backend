// Fresh, read-only verification against current database references and R2.
const path=require('node:path');
const fs=require('node:fs/promises');
const sharp=require('sharp');
const {sourceTarget}=require('./lib/imageCompressionBackfill');
const {complete,REUSE_VERSION,maxEdge}=require('./lib/jpegBackfill');
const {downloadImage}=require('./lib/jpegPilot');
const spaced=(rows,n)=>rows.length<=n?rows:Array.from({length:n},(_,i)=>rows[Math.round(i*(rows.length-1)/(n-1))]);

async function verify(prisma,s3,Command,inventoryFile){
    const before=JSON.parse(await fs.readFile(inventoryFile,'utf8'));
    const objects=new Map();let token;const seen=new Set();
    do{
        const page=await s3.send(new Command({Bucket:before.bucket,MaxKeys:1000,ContinuationToken:token}),{abortSignal:AbortSignal.timeout(45000)});
        for(const item of page.Contents||[])objects.set(item.Key,{bytes:Number(item.Size),etag:item.ETag});
        const next=page.IsTruncated?page.NextContinuationToken:undefined;
        if(page.IsTruncated&&(!next||seen.has(next)))throw new Error('incomplete_storage_inventory');
        if(next)seen.add(next);token=next;
    }while(token);
    const rows=await prisma.$queryRawUnsafe(`WITH refs AS (
      SELECT DISTINCT unnest(public.wareongo_image_urls(media::jsonb,photos)) AS url FROM "Warehouse"
    ) SELECT l.id,l."imageUrl",l.classification::text AS classification,l."jpegUrl",l."jpegStatus",
      l."jpegBytes"::text AS "jpegBytes",l."jpegVersion",l."jpegError"
      FROM refs LEFT JOIN labeled_warehouse_images l ON l."imageUrl"=refs.url ORDER BY l.id`);
    const imageDigests=await prisma.$queryRawUnsafe(`SELECT id,md5((to_jsonb(l)-ARRAY['jpegUrl','jpegBytes','jpegAt','jpegVersion','jpegStatus','jpegError'])::text) AS digest FROM labeled_warehouse_images l ORDER BY id`);
    const warehouseDigests=await prisma.$queryRawUnsafe(`SELECT id,md5(to_jsonb(w)::text) AS digest FROM "Warehouse" w ORDER BY id`);
    const differences=(earlier,current)=>{
        const map=new Map(current.map(row=>[row.id,row.digest]));const oldIds=new Set(earlier.map(row=>row.id));
        return {changed:earlier.filter(row=>map.has(row.id)&&map.get(row.id)!==row.digest).map(row=>row.id),
            removed:earlier.filter(row=>!map.has(row.id)).map(row=>row.id),added:current.filter(row=>!oldIds.has(row.id)).map(row=>row.id)};
    };
    const missingOriginals=[],changedOriginals=[],missingVariants=[],wrongBytes=[];
    for(const row of before.rows){
        const current=objects.get(row.originalKey);
        if(!current)missingOriginals.push(row.id);
        else if(current.bytes!==row.object.bytes||current.etag!==row.object.etag)changedOriginals.push(row.id);
    }
    const ready=rows.filter(complete),reused=ready.filter(row=>row.jpegVersion===REUSE_VERSION),encoded=ready.filter(row=>row.jpegVersion!==REUSE_VERSION);
    for(const row of ready){
        const key=sourceTarget(row.jpegUrl,before.publicBase)?.originalKey;const object=objects.get(key);
        if(!object)missingVariants.push(row.id);
        else if(String(object.bytes)!==row.jpegBytes)wrongBytes.push(row.id);
    }
    const sample=[...spaced(encoded.filter(row=>row.classification!=='DOCUMENT'),15),
        ...spaced(encoded.filter(row=>row.classification==='DOCUMENT'),5),...spaced(reused,8)];
    const decoded=[];
    for(const row of sample){
        const bytes=await downloadImage(row.jpegUrl,before.publicBase);
        const image=sharp(bytes,{limitInputPixels:16000000,failOn:'error'});
        const metadata=await image.metadata();
        if(metadata.format!=='jpeg'||String(bytes.length)!==row.jpegBytes
            ||metadata.width>maxEdge(row)||metadata.height>maxEdge(row)
            ||(metadata.orientation&&metadata.orientation!==1))throw new Error(`invalid_jpeg_sample_${row.id}`);
        await image.stats();decoded.push({imageId:row.id,width:metadata.width,height:metadata.height,bytes:bytes.length,version:row.jpegVersion});
    }
    const unfinished=rows.filter(row=>!complete(row)).map(row=>({id:row.id,status:row.jpegStatus,version:row.jpegVersion,reason:row.jpegError}));
    const result={verifiedAt:new Date().toISOString(),referencedImages:rows.length,ready:ready.length,
        reused:reused.length,encoded:encoded.length,jpegBytes:ready.reduce((n,row)=>n+Number(row.jpegBytes),0),
        encodedBytes:encoded.reduce((n,row)=>n+Number(row.jpegBytes),0),originalBytes:before.summary.sourceBytes,
        unfinished,missingOriginals,changedOriginals,missingVariants,wrongBytes,
        preservation:{scope:'Whole-table comparisons also include concurrent production activity. Each successful JPEG publication separately asserted unchanged non-JPEG fields in the same atomic statement.',
            images:differences(before.images,imageDigests),warehouses:differences(before.warehouses,warehouseDigests)},samplesDecoded:decoded.length,decoded};
    const report=path.resolve(__dirname,'../tools/image-pipeline',`${result.verifiedAt.replace(/[:.]/g,'-')}-jpeg-verification.json`);
    await fs.writeFile(report,JSON.stringify(result,null,2)+'\n',{mode:0o600});
    const {decoded:_,...summary}=result;console.log(JSON.stringify({...summary,report}));
    return result;
}

module.exports={verify};
if(require.main===module){
    if(process.argv.length!==3)throw new Error('Usage: verifyJpegBackfill.js path/to/inventory.json');
    require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});sharp.cache(false);sharp.concurrency(1);
    const {PrismaClient}=require('@prisma/client');const {S3Client,ListObjectsV2Command}=require('@aws-sdk/client-s3');
    const prisma=new PrismaClient();const s3=new S3Client({region:'auto',endpoint:`https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials:{accessKeyId:process.env.R2_ACCESS_KEY_ID,secretAccessKey:process.env.R2_SECRET_ACCESS_KEY},maxAttempts:2});
    verify(prisma,s3,ListObjectsV2Command,path.resolve(process.argv[2]))
        .then(result=>{if(result.unfinished.length||result.missingOriginals.length||result.changedOriginals.length||result.missingVariants.length||result.wrongBytes.length)process.exitCode=1;})
        .catch(error=>{console.error('JPEG verification failed',{name:error.name,code:error.code,reason:error.message.split('\n')[0]});process.exitCode=1;})
        .finally(async()=>{await prisma.$disconnect();s3.destroy();});
}
