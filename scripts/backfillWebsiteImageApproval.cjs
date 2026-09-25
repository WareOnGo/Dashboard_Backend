// One website-only processor for local backfills and the deployed scheduled stage.
// Row leases make restarts safe; no originals/variants are uploaded or modified.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { ImagePipelineRepository } = require('../src/models/imagePipelineRepository.cjs');
const WebsiteImageService = require('../src/services/websiteImageService');
const { MODEL, VERSION } = require('../src/utils/websiteImageAssessment.cjs');
const { retryDatabase, isTransientDatabaseError } = require('../src/utils/websiteImageDatabase.cjs');

async function stats(prisma) {
    const states = await prisma.$queryRawUnsafe(`SELECT "websiteStatus" AS status, "websiteDecision" AS decision,
      count(*)::int AS count FROM labeled_warehouse_images GROUP BY 1,2 ORDER BY 1,2`);
    const [queue] = await prisma.$queryRawUnsafe(`SELECT
      count(*) FILTER (WHERE "websiteStatus" = 'PENDING' OR ("websiteStatus" = 'FAILED' AND "websiteAttempts" < 5))::int AS retryable,
      count(*) FILTER (WHERE "websiteStatus" = 'FAILED' AND "websiteAttempts" >= 5)::int AS exhausted,
      count(*) FILTER (WHERE "websiteStatus" = 'RUNNING')::int AS running,
      min("websiteNextAttemptAt") FILTER (WHERE "websiteStatus" = 'FAILED' AND "websiteAttempts" < 5) AS "nextRetryAt"
      FROM labeled_warehouse_images`);
    return { total: states.reduce((n,r) => n+r.count,0), ready: states.filter(r=>r.status==='READY').reduce((n,r)=>n+r.count,0),
        states, ...queue };
}
async function run(prisma, { apply = false, concurrency = 12, limit = 100000, output }, signal) {
    const initial = await stats(prisma);
    if (!apply) return { mode: 'dry-run', model: MODEL, version: VERSION, concurrency, ...initial };
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
    const repository = new ImagePipelineRepository(prisma);
    const registered = await repository.register();
    const service = new WebsiteImageService(repository, null);
    fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    const journal = path.join(output, 'progress.jsonl');
    const started = Date.now(); let processed = 0, assessed = 0, totalFailed = 0, lastLogged = 0;
    const publish = async event => {
        lastLogged = Date.now();
        const state = await retryDatabase(() => stats(prisma));
        const elapsedSeconds = (Date.now()-started)/1000;
        const remaining = Math.max(0, state.total-state.ready-state.states.filter(r=>r.status==='UNSUPPORTED').reduce((n,r)=>n+r.count,0));
        const report = { at: new Date().toISOString(), pid: process.pid, event, model: MODEL, version: VERSION,
            registered, concurrency, session: { processed, assessed, failedAttempts: totalFailed, elapsedSeconds },
            rssMiB: Math.round(process.memoryUsage().rss/1048576),
            estimatedRemainingSeconds: assessed ? Math.round(remaining*elapsedSeconds/assessed) : null, ...state };
        const statusPath = path.join(output, 'status.json');
        fs.writeFileSync(`${statusPath}.tmp`, JSON.stringify(report,null,2)+'\n', { mode:0o600 });
        fs.renameSync(`${statusPath}.tmp`, statusPath);
        console.log(JSON.stringify(report));
        return state;
    };
    await publish('STARTED');
    let consecutiveDatabaseFailures = 0;
    while (!signal.aborted && processed < limit) {
        let result;
        try { result = await service.processBatch({ allEntries:true, concurrency, limit:Math.min(2000,limit-processed), signal,
            onResult: async entry => {
                processed++;
                if(entry.outcome==='READY')assessed++;
                if(['FAILED','UNSUPPORTED'].includes(entry.outcome))totalFailed++;
                fs.appendFileSync(journal,JSON.stringify({at:new Date().toISOString(),...entry})+'\n',{mode:0o600});
                if(Date.now()-lastLogged>30000) await publish('PROGRESS');
            } });
            consecutiveDatabaseFailures = 0;
        } catch (error) {
            if (!isTransientDatabaseError(error) || ++consecutiveDatabaseFailures > 5 || signal.aborted) throw error;
            console.log(JSON.stringify({event:'DATABASE_RECOVERY',at:new Date().toISOString(),code:error.code,attempt:consecutiveDatabaseFailures}));
            await delay(15000,null,{signal}).catch(error=>{if(!signal.aborted)throw error;});
            continue;
        }
        const state=await publish('BATCH');
        if (!state.retryable && !state.running) break;
        if (!result.processed && !signal.aborted) {
            const wait=state.nextRetryAt?Math.max(1000,new Date(state.nextRetryAt).getTime()-Date.now()):10000;
            await delay(Math.min(wait,30000),null,{signal}).catch(error=>{if(!signal.aborted)throw error;});
        }
    }
    const final=await publish(signal.aborted?'STOPPED':processed>=limit?'LIMIT_REACHED':'FINISHED');
    return { complete:final.ready===final.total, terminal:!final.retryable&&!final.running, ...final };
}
module.exports={run,stats};
if(require.main===module){
    // Local high-latency routes can exceed Node's default 250 ms address-family
    // attempt window. Keep the overall source/model deadlines unchanged.
    require('node:net').setDefaultAutoSelectFamilyAttemptTimeout(2000);
    require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
    const options={apply:false,concurrency:12,limit:100000}; let background=false;
    for(const arg of process.argv.slice(2)){
        if(arg==='--apply')options.apply=true;
        else if(arg==='--background')background=true;
        else if(arg.startsWith('--concurrency='))options.concurrency=Number(arg.slice(14));
        else if(arg.startsWith('--limit='))options.limit=Number(arg.slice(8));
        else if(arg.startsWith('--output='))options.output=path.resolve(arg.slice(9));
        else throw new Error('Unknown option');
    }
    if(!Number.isInteger(options.concurrency)||options.concurrency<1||options.concurrency>16
        ||!Number.isInteger(options.limit)||options.limit<1||options.limit>100000||!options.output)throw new Error('Supply bounded --concurrency/--limit and --output');
    if(background){
        if(!options.apply)throw new Error('Background mode requires --apply');
        fs.mkdirSync(options.output,{recursive:true,mode:0o700});
        const log=fs.openSync(path.join(options.output,'worker.log'),'a',0o600);
        const child=spawn(process.execPath,['--max-old-space-size=1024',__filename,...process.argv.slice(2).filter(a=>a!=='--background')],
            {detached:true,stdio:['ignore',log,log],cwd:path.resolve(__dirname,'..'),env:process.env});
        fs.writeFileSync(path.join(options.output,'worker.pid'),`${child.pid}\n`,{mode:0o600});
        child.unref();fs.closeSync(log);console.log(JSON.stringify({pid:child.pid,output:options.output}));
    }else{
        const {PrismaClient}=require('@prisma/client');
        const databaseUrl=new URL(process.env.DATABASE_URL);
        databaseUrl.searchParams.set('connection_limit','8');
        databaseUrl.searchParams.set('pool_timeout','30');
        const prisma=new PrismaClient({datasources:{db:{url:databaseUrl.toString()}}});
        const controller=new AbortController();for(const s of ['SIGINT','SIGTERM'])process.once(s,()=>controller.abort());
        require('sharp').concurrency(1);require('sharp').cache(false);
        run(prisma,options,controller.signal).then(result=>{console.log(JSON.stringify(result));if(!result.complete&&result.terminal)process.exitCode=2;})
            .catch(error=>{console.error(JSON.stringify({event:'FATAL',name:error.name,code:error.code}));process.exitCode=1;})
            .finally(()=>prisma.$disconnect());
    }
}
