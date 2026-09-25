// Two passes: publish suitable originals, then encode the remaining referenced images.
// No application flags, label writes, Warehouse writes, or object deletions.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { SMALL_BYTES, MAX_BYTES, REUSE_VERSION, maxEdge, versionFor, reusable, complete,
    targetFor, sha, pool, semaphore, checkMemory, download, decoder, batchPublisher } = require('./lib/jpegBackfill');
const { downloadImage } = require('./lib/jpegPilot');

function options(args) {
    const result = { apply:false, workers:8 };
    for (const arg of args) {
        if (arg === '--apply') result.apply=true;
        else if (arg.startsWith('--inventory=')) result.inventory=path.resolve(arg.slice(12));
        else if (/^--workers=(?:[1-9]|1[0-6])$/.test(arg)) result.workers=Number(arg.slice(10));
        else throw new Error('Usage: backfillJpegVariants.js --inventory=path [--apply] [--workers=1..16]');
    }
    if (!result.inventory) throw new Error('An explicit inventory is required');
    return result;
}

const reasonFor = error => /^[a-z_0-9]+$/.test(error?.message || '') ? error.message
    : error?.name === 'TimeoutError' ? 'network_timeout' : 'jpeg_transfer_or_database_failed';
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
async function retry(work, signal) {
    let error;
    for (let attempt=0;attempt<3;attempt++) {
        signal.throwIfAborted();
        try { return await work(); } catch (e) {
            error=e;
            if (/^source_(origin|too_large|empty)/.test(e.message)) throw e;
            if (attempt<2) await delay(500*(attempt+1));
        }
    }
    throw error;
}

async function run(prisma, config, storage, signal) {
    const inventory=JSON.parse(await fs.readFile(config.inventory,'utf8'));
    if (inventory.rows.some(row=>!row.id) || new URL(inventory.publicBase).origin !== new URL(storage.publicBase).origin
        || inventory.bucket !== storage.bucket) throw new Error('inventory_does_not_match_database_or_bucket');
    const current=await prisma.$queryRawUnsafe(`SELECT id,"imageUrl",classification::text AS classification,
      "jpegUrl","jpegVersion","jpegStatus","jpegBytes"::text AS "jpegBytes","jpegAt","jpegError"
      FROM labeled_warehouse_images WHERE id=ANY($1::int[]) ORDER BY id`,inventory.rows.map(row=>row.id));
    const byId=new Map(inventory.rows.map(row=>[row.id,row]));
    if(current.length!==inventory.rows.length || current.some(row=>row.imageUrl!==byId.get(row.id)?.imageUrl)) throw new Error('inventory_images_changed');
    const rows=current.map(row=>({...byId.get(row.id),...row}));
    const pending=rows.filter(row=>!complete(row));
    const summary={mode:config.apply?'apply':'dry-run',images:rows.length,alreadyReady:rows.length-pending.length,
        pending:pending.length,smallCandidates:pending.filter(row=>row.object?.bytes<=SMALL_BYTES).length,
        missingSources:pending.filter(row=>!row.object).length,workers:config.workers,decoders:2,
        photoMaxEdge:1280,documentMaxEdge:1920,quality:82,smallBytes:SMALL_BYTES};
    if(!config.apply) return summary;
    const startedAt=new Date().toISOString();
    const directory=path.resolve(__dirname,'../tools/image-pipeline',`${startedAt.replace(/[:.]/g,'-')}-jpeg-backfill`);
    await fs.mkdir(directory,{recursive:true,mode:0o700});
    const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'warehouse-jpeg-backfill-'));
    const reportFile=path.join(directory,'report.json');
    const journal=path.join(directory,'results.ndjson');
    await fs.writeFile(path.join(directory,'before.json'),JSON.stringify({inventory:config.inventory,rows},null,2)+'\n',{mode:0o600});
    const report={...summary,startedAt,directory,phase:'reuse',reuseScanned:0,compressScanned:0,reused:0,
        compressed:0,uploaded:0,existingObjectReused:0,stale:0,failed:0,sourceBytes:0,jpegBytes:0,
        newR2Bytes:0,peakDecoderMiB:0,peakParentMiB:0,errors:[],passComplete:false};
    let checkpointChain=Promise.resolve();
    const checkpoint=()=>{
        report.checkedAt=new Date().toISOString();
        report.peakParentMiB=Math.max(report.peakParentMiB,Math.ceil(process.memoryUsage().rss/1024/1024));
        const snapshot=JSON.stringify(report,null,2)+'\n';
        checkpointChain=checkpointChain.then(async()=>{
            await fs.writeFile(`${reportFile}.tmp`,snapshot,{mode:0o600}); await fs.rename(`${reportFile}.tmp`,reportFile);
        });
        return checkpointChain;
    };
    const log=()=>{const {errors,...data}=report;console.log(JSON.stringify({...data,recentErrors:errors.slice(-3),report:reportFile}));};
    const timer=setInterval(()=>{checkpoint().then(log).catch(()=>{});},20000);
    const encodeGate=semaphore(2);
    const publish=batchPublisher(prisma,Math.min(config.workers,8));
    const decoded=async(input,output,mode,edge)=>encodeGate(async()=>{
        signal.throwIfAborted();await checkMemory();
        const result=await decoder(input,output,mode,edge,signal);
        report.peakDecoderMiB=Math.max(report.peakDecoderMiB,result.peakRssMiB||0);return result;
    });
    const cached=new Map();
    const finished=new Set();
    const append=result=>fs.appendFile(journal,JSON.stringify(result)+'\n',{mode:0o600});
    const clean=async row=>{
        cached.delete(row.id);
        await Promise.all([fs.rm(path.join(scratch,`${row.id}.original`),{force:true}),fs.rm(path.join(scratch,`${row.id}.jpg`),{force:true})]);
    };
    const getSource=async row=>{
        if(cached.has(row.id))return cached.get(row.id);
        await checkMemory();
        if(!row.object)throw new Error('source_missing_from_inventory');
        if(row.object.bytes>MAX_BYTES)throw new Error('source_too_large');
        const file=path.join(scratch,`${row.id}.original`);
        const result=await retry(()=>download(row.imageUrl,file,storage.publicBase,signal),signal);
        const value={...result,file};cached.set(row.id,value);return value;
    };
    const publishResult=async(row,result,source,action,extra={})=>{
        const updated=await retry(()=>publish(row,result),signal);
        const entry={imageId:row.id,action:updated?action:'stale',originalUrl:row.imageUrl,jpegUrl:result.url,
            version:result.version,sourceBytes:source.bytes,jpegBytes:result.bytes,
            previousJpegUrl:row.jpegUrl,nonJpegFieldsPreserved:updated,...extra};
        await append(entry);
        if(updated){report[action]++;report.sourceBytes+=source.bytes;report.jpegBytes+=result.bytes;}
        else report.stale++;
        finished.add(row.id);await clean(row);
    };
    try {
        await checkpoint();log();
        // Finish this whole pass before a single new object is uploaded.
        await pool(pending.filter(row=>row.object?.bytes>0&&row.object.bytes<=SMALL_BYTES),config.workers,async row=>{
            try{
                const source=await getSource(row);
                const inspected=await decoded(source.file,path.join(scratch,`${row.id}.jpg`),'inspect',maxEdge(row));
                if(reusable(inspected.metadata,source.bytes,maxEdge(row),row.imageUrl)){
                    await publishResult(row,{url:row.imageUrl,bytes:source.bytes,version:REUSE_VERSION},source,'reused');
                }
            }catch(error){
                if(signal.aborted||error.message==='jpeg_memory_pressure')throw error;
                // Retry transfer/decode failures in pass two. Never tag an unchecked original READY.
                await clean(row);
            }finally{await clean(row);report.reuseScanned++;}
        },signal);
        report.phase='compress';await checkpoint();log();
        await pool(pending.filter(row=>!finished.has(row.id)).sort((a,b)=>(a.object?.bytes||0)-(b.object?.bytes||0)),config.workers,async row=>{
            let uploadedKey;
            try{
                const source=await getSource(row),output=path.join(scratch,`${row.id}.jpg`);
                const encoded=await decoded(source.file,output,'compress',maxEdge(row));
                if(encoded.jpegBytes>=source.bytes&&reusable(encoded.metadata,source.bytes,maxEdge(row),row.imageUrl,{smallOnly:false})){
                    await publishResult(row,{url:row.imageUrl,bytes:source.bytes,version:REUSE_VERSION},source,'reused');return;
                }
                const target=targetFor(row,source.hash,storage.publicBase);
                const jpeg=await fs.readFile(output);
                let uploaded=false;
                try{
                    await retry(()=>storage.s3.send(new storage.PutObjectCommand({Bucket:storage.bucket,Key:target.key,Body:jpeg,
                        ContentType:'image/jpeg',CacheControl:'public,max-age=31536000,immutable',IfNoneMatch:'*',
                        Metadata:{'source-sha256':source.hash,'original-url-sha256':sha(row.imageUrl),'jpeg-version':versionFor(row)}}),
                    {abortSignal:AbortSignal.any([signal,AbortSignal.timeout(45000)])}),signal);
                    uploaded=true;uploadedKey=target.key;report.uploaded++;report.newR2Bytes+=jpeg.length;
                }catch(error){if(error.$metadata?.httpStatusCode!==412)throw error;report.existingObjectReused++;}
                const stored=await retry(()=>downloadImage(target.url,storage.publicBase),signal);
                if(sha(stored)!==sha(jpeg))throw new Error('stored_jpeg_does_not_match');
                await publishResult(row,{url:target.url,bytes:jpeg.length,version:versionFor(row)},source,'compressed',
                    {uploaded,objectKey:target.key,width:encoded.width,height:encoded.height});
            }catch(error){
                if(signal.aborted||error.message==='jpeg_memory_pressure')throw error;
                const reason=reasonFor(error);
                const details={name:error.name,code:error.code,httpStatus:error.$metadata?.httpStatusCode,
                    causeCode:error.cause?.code};
                report.failed++;report.errors.push({imageId:row.id,reason,uploadedKey,...details});
                await append({imageId:row.id,action:'failed',reason,uploadedKey,...details});
                await prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images SET "jpegStatus"=$3,"jpegError"=$4
                  WHERE id=$1 AND "imageUrl"=$2 AND "jpegUrl" IS NULL`,row.id,row.imageUrl,
                /source_(too_large|too_many_pixels|animated_or_multipage|origin)/.test(reason)?'UNSUPPORTED':'FAILED',reason);
                await clean(row);
            }finally{await clean(row);report.compressScanned++;}
        },signal);
        report.passComplete=true;report.phase='complete';report.finishedAt=new Date().toISOString();
    }catch(error){report.phase='stopped';report.fatal={reason:reasonFor(error)};throw error;}
    finally{clearInterval(timer);await checkpoint();log();await fs.rm(scratch,{recursive:true,force:true});}
    return {...report,report:reportFile};
}

module.exports={options,run};
if(require.main===module){
    const config=options(process.argv.slice(2));
    require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
    const {PrismaClient}=require('@prisma/client');
    const {S3Client,PutObjectCommand}=require('@aws-sdk/client-s3');
    const prisma=new PrismaClient();
    const s3=new S3Client({region:'auto',endpoint:`https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials:{accessKeyId:process.env.R2_ACCESS_KEY_ID,secretAccessKey:process.env.R2_SECRET_ACCESS_KEY},
        requestChecksumCalculation:'WHEN_REQUIRED',maxAttempts:2});
    const controller=new AbortController();
    const stop=()=>controller.abort(new Error('operator_interrupted'));
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    run(prisma,config,{s3,PutObjectCommand,bucket:process.env.R2_BUCKET_NAME,publicBase:process.env.R2_PUBLIC_URL},controller.signal)
        .then(report=>{console.log(JSON.stringify(report));if(report.failed||report.stale)process.exitCode=1;})
        .catch(error=>{console.error('JPEG backfill stopped',{reason:reasonFor(error),name:error.name,code:error.code});process.exitCode=1;})
        .finally(async()=>{await prisma.$disconnect();s3.destroy();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);});
}
