// Read-only checks. Print aggregate results and field paths, never raw values.
const path=require('node:path');
const assert=require('node:assert/strict');
const {PrismaClient}=require('@prisma/client');
require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
const url=new URL(process.env.DATABASE_URL);url.searchParams.set('connection_limit','1');
const db=new PrismaClient({datasources:{db:{url:url.toString()}}});
const internal=new Set(['owner','createdby','updatedby','assignee','assignedto','secondaryassignee']);
const contact=/email|phone|mobile|whatsapp|contactnumber|contactno/;
const metadata=new Set(['primaryphonecountrycode','primaryphonecallingcode','countrycode','callingcode']);
const changes=new Map();const leaks=new Map();
function walk(raw,masked,parts=[],sensitive=false) {
  const key=String(parts.at(-1)||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  if(internal.has(key)||metadata.has(key)) {assert.deepEqual(masked,raw,'Internal identity/phone metadata changed');return;}
  sensitive=sensitive||contact.test(key);
  if(Array.isArray(raw)) {
    assert.ok(Array.isArray(masked));assert.equal(masked.length,raw.length);
    raw.forEach((v,i)=>walk(v,masked[i],[...parts,'[]'],sensitive));return;
  }
  if(raw&&typeof raw==='object') {
    assert.deepEqual(Object.keys(masked).sort(),Object.keys(raw).sort(),'Raw JSON key dropped');
    for(const [name,value]of Object.entries(raw))walk(value,masked[name],[...parts,name],sensitive);
    return;
  }
  if(raw===null||typeof raw==='boolean'||raw==='') {assert.equal(masked,raw);return;}
  const label=parts.join('.');
  if(sensitive&&String(raw).trim())assert.equal(masked,'[REDACTED]','Structured contact was not redacted');
  if(masked!==raw)changes.set(label,(changes.get(label)||0)+1);
  if(typeof masked==='string' && /[A-Z0-9._%+!#$&'*\/=?^`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(masked)) {
    leaks.set(label,(leaks.get(label)||0)+1);
  }
}

async function run() {
  const rawRows=await db.$queryRawUnsafe(`SELECT 'opportunities' AS object,opportunity_id AS id,data FROM public.opportunities
    UNION ALL SELECT object,record_id,data FROM public.crm_records`);
  const maskedRows=await db.$transaction(async tx=>{
    await tx.$executeRawUnsafe('SET LOCAL ROLE crm_analytics_reader');
    return tx.$queryRawUnsafe(`SELECT 'opportunities' AS object,opportunity_id AS id,data FROM analytics.crm_opportunities
      UNION ALL SELECT 'notes',note_id,data FROM analytics.crm_notes
      UNION ALL SELECT 'tasks',task_id,data FROM analytics.crm_tasks`);
  },{timeout:90000});
  const byId=new Map(maskedRows.map(r=>[`${r.object}:${r.id}`,r.data]));
  const rows=rawRows.map(r=>({raw:r.data,masked:byId.get(`${r.object}:${r.id}`)}));
  for(const row of rows)walk(row.raw,row.masked);
  assert.equal(leaks.size,0,'Client email pattern survived masking');
  const stage=await db.$queryRawUnsafe(`SELECT count(*)::int AS stored_transitions,count(DISTINCT opportunity_id)::int AS opportunities_with_history,
    min(changed_at) AS earliest_change,max(changed_at) AS latest_change,
    (SELECT sum(observed_stage_change_count)::int FROM analytics.crm_opportunities) AS exposed_transitions,
    (SELECT count(*)::int FROM (SELECT opportunity_id,from_stage,to_stage,changed_at FROM public.stage_transitions
      GROUP BY 1,2,3,4 HAVING count(*)>1) d) AS duplicate_transition_groups FROM public.stage_transitions`);
  assert.equal(stage[0].stored_transitions,stage[0].exposed_transitions);
  const notes=await db.$queryRawUnsafe(`SELECT object,count(*)::int AS rows,
    max(length(data#>>'{bodyV2,markdown}'))::int AS longest_markdown,
    count(*) FILTER(WHERE data ? 'bodyV2')::int AS with_full_body,
    sum(cardinality(opportunity_ids))::int AS opportunity_links FROM public.crm_records GROUP BY object ORDER BY object`);
  console.log(JSON.stringify({checkedRawRecords:rows.length,structurePreserved:true,structuredContactsMasked:true,clientEmailPatternsRemaining:leaks.size,
    changedPaths:Object.fromEntries([...changes].sort()),stageHistory:stage[0],rawNotesTasks:notes},null,2));
}
run().catch(e=>{console.error(JSON.stringify({error:'CRM_MIRROR_CHECK_FAILED',code:e.code,sqlState:e.meta?.code,reason:e instanceof assert.AssertionError?e.message:undefined}));process.exitCode=1;}).finally(()=>db.$disconnect());
