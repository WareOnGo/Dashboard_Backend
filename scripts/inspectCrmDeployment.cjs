const path=require('node:path');
const {PrismaClient}=require('@prisma/client');
require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
const db=new PrismaClient();
async function run() {
  const jobs=await db.$queryRawUnsafe("SELECT jobname,command FROM cron.job WHERE jobname IN ('crm-sync-delta','crm-sync-full')");
  const result=jobs.map(job=>{
    const match=job.command.match(/url\s*:=\s*'([^']+)'/i);
    const url=match?new URL(match[1]):null;
    return {job:job.jobname,protocol:url?.protocol,host:url?.hostname,port:url?.port,path:url?.pathname,
      timeoutMilliseconds:job.command.match(/timeout_milliseconds\s*:=\s*(\d+)/i)?.[1]};
  });
  const checkpoint=await db.$queryRawUnsafe("SELECT object,last_run_at,last_run_status FROM public.sync_checkpoints WHERE object IN ('opportunities','notes','tasks','__sync_lock__') ORDER BY object");
  console.log(JSON.stringify({jobs:result,checkpoint}));
}
run().catch(e=>{console.error(JSON.stringify({error:e.code}));process.exitCode=1;}).finally(()=>db.$disconnect());
