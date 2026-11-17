const fs=require('node:fs');
const path=require('node:path');
const dotenv=require('dotenv');
const {PrismaClient}=require('@prisma/client');
dotenv.config({path:path.resolve(__dirname,'../.env'),quiet:true});
const db=new PrismaClient();
async function run() {
  const stored=await db.$queryRawUnsafe(`SELECT e.key,jsonb_typeof(e.value) AS type,count(*)::int AS records,
    count(*) FILTER(WHERE e.value NOT IN ('null'::jsonb,'[]'::jsonb,'""'::jsonb))::int AS populated
    FROM public.opportunities o CROSS JOIN LATERAL jsonb_each(o.data) e
    WHERE o.deleted_at IS NULL AND e.key ILIKE '%secondary%' GROUP BY 1,2 ORDER BY 1,2`);
  const config=dotenv.parse(fs.readFileSync('/home/rs0125/dev/wareongo/CRM-Automations/.env','utf8'));
  const url=new URL(`${config.TWENTY_CRM_BASE_URL.replace(/\/$/,'')}/rest/opportunities`);
  for(const [key,value] of Object.entries({limit:'60',depth:'1',order_by:'updatedAt[DescNullsLast]'}))url.searchParams.set(key,value);
  const response=await fetch(url,{headers:{Authorization:`Bearer ${config.TWENTY_CRM_API_KEY}`},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error('TWENTY_READ_FAILED');
  const body=await response.json();const records=body.data.opportunities;
  const fields={};
  for(const record of records)for(const [key,value]of Object.entries(record))if(/secondary/i.test(key)) {
    const entry=fields[key]??={records:0,populated:0,types:new Set(),elementTypes:new Set()};
    entry.records++;entry.types.add(Array.isArray(value)?'array':value===null?'null':typeof value);
    if(value!==null&&value!==''&&(!Array.isArray(value)||value.length))entry.populated++;
    if(Array.isArray(value))for(const item of value)entry.elementTypes.add(typeof item);
  }
  console.log(JSON.stringify({stored,liveSampleSize:records.length,liveFields:Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,{...value,types:[...value.types],elementTypes:[...value.elementTypes]}]))}));
}
run().catch(e=>{console.error(JSON.stringify({error:e.code||e.name,sqlState:e.meta?.code}));process.exitCode=1;}).finally(()=>db.$disconnect());
