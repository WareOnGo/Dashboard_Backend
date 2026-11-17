// Exercise the existing scheduled /sync endpoint with its configured credentials.
// Only prints HTTP status and aggregate sync counts, never URLs, secrets or payloads.
const path=require('node:path');
const assert=require('node:assert/strict');
const dotenv=require('dotenv');
const {PrismaClient}=require('@prisma/client');
dotenv.config({path:path.resolve(__dirname,'../.env'),quiet:true});
const db=new PrismaClient();
async function run() {
  const [job]=await db.$queryRawUnsafe("SELECT command FROM cron.job WHERE jobname='crm-sync-delta' AND active");
  const endpoint=job?.command.match(/url\s*:=\s*'([^']+)'/i)?.[1];
  assert.ok(endpoint,'Could not identify existing sync URL');
  const url=new URL(endpoint);assert.equal(url.pathname,'/sync');
  const auth=job.command.match(/['"]X-Auth['"]\s*(?:,|:)\s*['"]([^'"]+)['"]/i)?.[1];
  assert.ok(auth,'Could not identify existing cron authentication header');
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Auth':auth},
    body:JSON.stringify({full:false}),signal:AbortSignal.timeout(300000)});
  const result=await response.json();
  const output={httpStatus:response.status,status:result.status,skipped:result.skipped,durationMs:result.durationMs,streams:{}};
  for(const [object,stream]of Object.entries(result.streams||{})) {
    output.streams[object]={count:stream.count,failures:stream.failures,unresolvedLinks:stream.unresolvedLinks,reconciliationSkipped:stream.reconciliationSkipped,hasError:!!stream.error};
  }
  console.log(JSON.stringify(output));
  if(response.status===202||result.skipped) {process.exitCode=2;return;}
  assert.equal(response.status,200);assert.equal(result.status,'ok');
  assert.ok(result.streams?.opportunities?.count>1900,'Worker did not refresh full opportunity snapshots');
  assert.ok(result.streams?.notes?.count>=368,'Worker did not refresh full note snapshots');
  assert.ok(result.streams?.tasks?.count>=99,'Worker did not refresh full task snapshots');
  assert.ok(Object.values(result.streams).every(s=>s.failures===0),'Worker reported failed writes');
}
run().catch(e=>{console.error(JSON.stringify({error:'DEPLOYED_CRM_CHECK_FAILED',code:e.code,name:e.name,reason:e instanceof assert.AssertionError?e.message:undefined}));process.exitCode=1;}).finally(()=>db.$disconnect());
