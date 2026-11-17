const path=require('node:path');
const {PrismaClient}=require('@prisma/client');
require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
const db=new PrismaClient();
async function run() {
  const duplicates=await db.$queryRawUnsafe(`SELECT from_stage,to_stage,changed_at,count(*)::int AS copies,
    min(detected_at) AS first_detected,max(detected_at) AS last_detected
    FROM public.stage_transitions GROUP BY opportunity_id,from_stage,to_stage,changed_at HAVING count(*)>1 ORDER BY first_detected`);
  const [baseline]=await db.$queryRawUnsafe(`SELECT count(*)::int AS rows,max(id)::text AS max_id,
    md5(string_agg(row_to_json(t)::text,',' ORDER BY id)) AS fingerprint
    FROM public.stage_transitions t WHERE detected_at < '2026-10-08T00:00:00Z'`);
  const [entryTimes]=await db.$queryRawUnsafe(`SELECT count(*)::int AS matched_transitions,
    count(*) FILTER(WHERE o.stage_entered_at=t.changed_at)::int AS consistent_stage_entry_times
    FROM public.opportunities o JOIN LATERAL (
      SELECT to_stage,changed_at FROM public.stage_transitions s WHERE s.opportunity_id=o.opportunity_id
      ORDER BY changed_at DESC,id DESC LIMIT 1) t ON true WHERE o.stage=t.to_stage`);
  console.log(JSON.stringify({duplicates,historicalBaseline:baseline,entryTimes}));
}
run().catch(e=>{console.error(JSON.stringify({error:e.code,sqlState:e.meta?.code}));process.exitCode=1;}).finally(()=>db.$disconnect());
