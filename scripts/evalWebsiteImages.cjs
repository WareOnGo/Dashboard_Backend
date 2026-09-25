// Bounded, resumable shadow evaluation. Never writes database rows or R2 objects.
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const sharp=require('sharp');
const {callModel}=require('../src/utils/imageClassifier');
const {VERSION,PROMPT,SCHEMA}=require('./lib/websiteImageEvaluation.cjs');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

async function download(url) {
    const response=await fetch(url,{signal:AbortSignal.timeout(30000),redirect:'error'});
    if(!response.ok)throw new Error(`image_http_${response.status}`);
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>20*1024*1024)throw new Error('image_over_20MiB');chunks.push(chunk);}
    if(!size)throw new Error('empty_image');
    return Buffer.concat(chunks);
}
async function localImage(row,directory) {
    const file=path.join(directory,`${row.id}.original`);
    let original=await fs.readFile(file).catch(()=>null);
    if(!original){original=await download(row.imageUrl);await fs.writeFile(file,original,{mode:0o600});}
    const input=()=>sharp(original,{limitInputPixels:40000000,failOn:'error'}).rotate();
    const metadata=await input().metadata();
    const swap=metadata.orientation>=5&&metadata.orientation<=8;
    await input().resize({width:400,height:270,fit:'inside',withoutEnlargement:true}).jpeg({quality:88})
        .toFile(path.join(directory,`${row.id}.preview.jpg`));
    const tiny=await input().resize(9,8,{fit:'fill'}).greyscale().raw().toBuffer();
    let bits=0n;for(let y=0;y<8;y++)for(let x=0;x<8;x++)bits=(bits<<1n)|BigInt(tiny[y*9+x]>tiny[y*9+x+1]);
    return {originalFile:file,bytes:original.length,sha256:sha(original),dHash:bits.toString(16).padStart(16,'0'),
        width:swap?metadata.height:metadata.width,height:swap?metadata.width:metadata.height,format:metadata.format};
}
async function run({sampleFile,output,model='gpt-5.6-terra',limit=256,runModel=false,inlineImages=false}) {
    const sample=JSON.parse(await fs.readFile(sampleFile,'utf8'));
    if(sample.version!==VERSION||sample.images.length>256||limit>256||limit<1)throw new Error('Invalid sample or cap');
    const rows=sample.images.slice(0,limit);
    if(!runModel)return {readOnly:true,images:rows.length,model,detail:'high',maxConcurrency:4,output,runModel:false};
    if(!process.env.OPENAI_API_KEY)throw new Error('OPENAI_API_KEY missing');
    await fs.mkdir(path.join(output,'images'),{recursive:true,mode:0o700});
    const journal=path.join(output,`${VERSION}-${model}.jsonl`);
    const previous=(await fs.readFile(journal,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    const cached=new Map(previous.filter(row=>row.assessment&&!row.error).map(row=>[row.id,row]));
    const results=new Array(rows.length);let next=0,done=0;
    await Promise.all(Array.from({length:Math.min(4,rows.length)},async()=>{
        while(next<rows.length){
            const i=next++,row=rows[i];
            if(cached.has(row.id)){results[i]=cached.get(row.id);done++;continue;}
            let result;
            try {
                const local=await localImage(row,path.join(output,'images'));
                const mime=local.format==='jpeg'?'image/jpeg':`image/${local.format}`;
                const input=inlineImages?`data:${mime};base64,${(await fs.readFile(local.originalFile)).toString('base64')}`:row.imageUrl;
                const response=await callModel(model,input,PROMPT,SCHEMA,
                    {detail:'high',maxAttempts:2,schemaName:'website_image_eval',signal:AbortSignal.timeout(120000)});
                const {inputTokens,outputTokens,latencyMs,error,...assessment}=response;
                result={id:row.id,originalUrl:row.imageUrl,warehouseIds:row.warehouseIds,sampleKind:row.sampleKind,
                    previousScene:row.classification,local,model,version:VERSION,inputTransport:inlineImages?'original-bytes':'original-url',
                    ...(error?{error}:{assessment}),inputTokens,outputTokens,latencyMs};
            }catch(error){result={id:row.id,error:error.message};}
            results[i]=result;
            await fs.appendFile(journal,JSON.stringify(result)+'\n',{mode:0o600});
            done++;if(done%10===0||done===rows.length)console.log(JSON.stringify({done,total:rows.length,failures:results.filter(r=>r?.error).length}));
        }
    }));
    const report={version:VERSION,model,at:new Date().toISOString(),sourceInventoryReadOnly:true,
        inputSample:sampleFile,sampleCohortIds:sample.cohortIds,stressIds:sample.stressIds,results};
    await fs.writeFile(path.join(output,`results-${model}.json`),JSON.stringify(report,null,2)+'\n',{mode:0o600});
    return {file:path.join(output,`results-${model}.json`),images:results.length,failed:results.filter(r=>r.error).length,
        inputTokens:results.reduce((n,r)=>n+(r.inputTokens||0),0),outputTokens:results.reduce((n,r)=>n+(r.outputTokens||0),0)};
}

module.exports={run,localImage};
if(require.main===module){
    const args={};for(const arg of process.argv.slice(2)){
        if(arg==='--run-model')args.runModel=true;
        else if(arg==='--inline')args.inlineImages=true;
        else if(arg.startsWith('--sample='))args.sampleFile=path.resolve(arg.slice(9));
        else if(arg.startsWith('--output='))args.output=path.resolve(arg.slice(9));
        else if(arg.startsWith('--model='))args.model=arg.slice(8);
        else if(arg.startsWith('--limit='))args.limit=Number(arg.slice(8));
        else throw new Error('Unknown option');
    }
    if(!args.sampleFile||!args.output)throw new Error('Supply --sample=path --output=directory [--run-model]');
    require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
    sharp.cache(false);sharp.concurrency(1);
    run(args).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
