// Read-only inventory. Prints schema, JSON keys, types and aggregate counts only.
const path = require('node:path');
const fs = require('node:fs');
const dotenv = require('dotenv');
const { PrismaClient } = require('@prisma/client');
dotenv.config({path:path.resolve(__dirname,'../.env'),quiet:true});
const connection=new URL(process.env.DATABASE_URL);
connection.searchParams.set('connection_limit','1');
connection.searchParams.set('connect_timeout','10');
connection.searchParams.set('sslmode','require');
const db=new PrismaClient({datasources:{db:{url:connection.toString()}}});
function print(label,value){console.log(JSON.stringify({[label]:value}));}
async function inspect() {
  await db.$transaction(async tx=>{
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout='20s'");
    print('context',await tx.$queryRawUnsafe('SELECT current_database() AS db,current_user AS role,now() AS checked_at'));
    print('crmRelations',await tx.$queryRawUnsafe(`SELECT n.nspname AS schema,c.relname,c.relkind,c.relrowsecurity,pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','v','m','p')
      AND c.relname ~* 'opportunit|stage_trans|sync_check|twenty|crm|note|task|compan|people|person' ORDER BY 1,2`));
    print('columns',await tx.$queryRawUnsafe(`SELECT table_name,column_name,data_type,udt_name,is_nullable FROM information_schema.columns
      WHERE table_schema='public' AND table_name IN ('opportunities','stage_transitions','sync_checkpoints') ORDER BY table_name,ordinal_position`));
    print('opportunitySummary',await tx.$queryRawUnsafe(`SELECT count(*)::int AS rows,
      count(*) FILTER(WHERE deleted_at IS NULL)::int AS active_rows,
      count(*) FILTER(WHERE jsonb_typeof(data)='object')::int AS json_objects,
      count(*) FILTER(WHERE data ? 'updatedAt')::int AS rest_snapshots,
      count(*) FILTER(WHERE data ? 'last_updated')::int AS legacy_snapshots,
      count(*) FILTER(WHERE last_note_text IS NOT NULL)::int AS with_note_text,
      max(length(last_note_text))::int AS longest_note_chars,
      count(*) FILTER(WHERE length(last_note_text)>=2000)::int AS notes_at_truncation_limit,
      count(*) FILTER(WHERE last_task_at IS NOT NULL)::int AS with_task_time,
      min(twenty_created_at) AS earliest_twenty_created,max(twenty_updated_at) AS latest_twenty_updated,
      min(last_polled_at) AS oldest_poll,max(last_polled_at) AS latest_poll FROM public.opportunities`));
    print('snapshotAges',await tx.$queryRawUnsafe(`SELECT data ? 'updatedAt' AS rest_shaped,deleted_at IS NOT NULL AS deleted,count(*)::int AS rows,
      min(last_polled_at) AS oldest_poll,max(last_polled_at) AS latest_poll FROM public.opportunities GROUP BY 1,2 ORDER BY 1,2`));
    print('jsonKeys',await tx.$queryRawUnsafe(`SELECT e.key,jsonb_typeof(e.value) AS type,count(*)::int AS rows,
      count(*) FILTER(WHERE e.value NOT IN ('null'::jsonb,'""'::jsonb,'[]'::jsonb,'{}'::jsonb))::int AS populated
      FROM public.opportunities o CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(o.data)='object' THEN o.data ELSE '{}'::jsonb END) e GROUP BY 1,2 ORDER BY 1,2`));
    print('nestedJsonKeys',await tx.$queryRawUnsafe(`SELECT e.key AS parent,n.key,jsonb_typeof(n.value) AS type,count(*)::int AS rows
      FROM public.opportunities o CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(o.data)='object' THEN o.data ELSE '{}'::jsonb END) e
      CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(e.value)='object' THEN e.value ELSE '{}'::jsonb END) n
      GROUP BY 1,2,3 ORDER BY 1,2,3`));
    print('arrayShapes',await tx.$queryRawUnsafe(`SELECT e.key,jsonb_typeof(a.value) AS element_type,
      CASE WHEN jsonb_typeof(a.value)='object' THEN (SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(a.value) k) ELSE NULL END AS object_keys,count(*)::int AS elements
      FROM public.opportunities o CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(o.data)='object' THEN o.data ELSE '{}'::jsonb END) e
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.value)='array' THEN e.value ELSE '[]'::jsonb END) a
      GROUP BY 1,2,3 ORDER BY 1,2 LIMIT 100`));
    print('stages',await tx.$queryRawUnsafe('SELECT stage,count(*)::int AS rows FROM public.opportunities GROUP BY stage ORDER BY rows DESC'));
    print('transitions',await tx.$queryRawUnsafe('SELECT count(*)::int AS rows,count(DISTINCT opportunity_id)::int AS opportunities,min(changed_at) AS first_change,max(changed_at) AS last_change FROM public.stage_transitions'));
    print('checkpoints',await tx.$queryRawUnsafe("SELECT object,last_updated_at,last_run_at,last_run_status,last_error IS NOT NULL AS has_error FROM public.sync_checkpoints WHERE object<>'__sync_lock__' ORDER BY object"));
    print('schedules',await tx.$queryRawUnsafe("SELECT jobname,schedule,active FROM cron.job WHERE jobname LIKE 'crm-%' ORDER BY jobname"));
    print('existingAnalytics',await tx.$queryRawUnsafe("SELECT n.nspname,c.relname,pg_get_userbyid(c.relowner) AS owner,c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='analytics' AND c.relkind IN ('v','r','m')"));
    print('publicExtensionGrants',await tx.$queryRawUnsafe(`SELECT n.nspname,c.relname,has_schema_privilege('analytics_reader',n.oid,'USAGE') AS reader_schema_usage,
      has_table_privilege('analytics_reader',c.oid,'SELECT') AS reader_select,has_table_privilege('analytics_reader',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') AS reader_write
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='net' AND c.relkind='r'`));
  },{timeout:90000});
  if(process.argv.includes('--twenty')||process.argv.includes('--full-twenty')) {
    const config=dotenv.parse(fs.readFileSync('/home/rs0125/dev/wareongo/CRM-Automations/.env','utf8'));
    const base=config.TWENTY_CRM_BASE_URL;
    const token=config.TWENTY_CRM_API_KEY;
    if(!base||!token){print('twenty',{configured:false});return;}
    for(const object of ['opportunities','notes','tasks']) {
      const endpoint=new URL(`${base.replace(/\/$/,'')}/rest/${object}`);
      endpoint.searchParams.set('limit','5');endpoint.searchParams.set('depth','1');endpoint.searchParams.set('order_by','updatedAt[DescNullsLast]');
      let response;
      try {response=await fetch(endpoint,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)});}
      catch {print('twenty',{object,reachable:false});continue;}
      if(!response.ok){print('twenty',{object,httpStatus:response.status});continue;}
      const body=await response.json();
      const records=body.data?.[object]??[];
      const keys=[...new Set(records.flatMap(r=>Object.keys(r)))].sort();
      const result={object,httpStatus:response.status,sampled:records.length,keys,hasNextPage:body.pageInfo?.hasNextPage??null};
      if(object==='opportunities') {
        const details=[];
        for(const record of records) {
          const [mirror]=await db.$queryRawUnsafe('SELECT data FROM public.opportunities WHERE opportunity_id=$1',record.id);
          details.push({mirrored:Boolean(mirror),sameUpdatedAt:mirror?.data?.updatedAt===record.updatedAt,
            droppedKeys:mirror?Object.keys(record).filter(k=>!Object.hasOwn(mirror.data,k)).sort():[],
            storedKeysNotReturned:mirror?Object.keys(mirror.data).filter(k=>!Object.hasOwn(record,k)).sort():[]});
        }
        result.comparison=details;
      }
      print('twenty',result);
    }
    if(process.argv.includes('--full-twenty')) {
      const stored=await db.$queryRawUnsafe('SELECT opportunity_id,data,deleted_at,last_note_text FROM public.opportunities');
      const byId=new Map(stored.map(r=>[r.opportunity_id,r]));
      const liveIds=new Set();
      const missingKeys=new Map(),differentKeys=new Map();
      let count=0,absent=0,stale=0,cursor=null,pages=0;
      const canonical=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v);
      for(;pages<1000;pages++) {
        const endpoint=new URL(`${base.replace(/\/$/,'')}/rest/opportunities`);
        for(const [key,value]of Object.entries({limit:'60',depth:'1',order_by:'updatedAt[AscNullsFirst]',...(cursor?{starting_after:cursor}:{})})) endpoint.searchParams.set(key,value);
        const response=await fetch(endpoint,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});
        if(!response.ok)throw new Error('TWENTY_READ_FAILED');
        const body=await response.json();const records=body.data?.opportunities??[];
        for(const record of records) {
          count++;liveIds.add(record.id);const mirror=byId.get(record.id);
          if(!mirror){absent++;continue;}
          if(mirror.data.updatedAt!==record.updatedAt)stale++;
          for(const [key,value]of Object.entries(record)) {
            if(!Object.hasOwn(mirror.data,key)) {
              const state=missingKeys.get(key)||{rows:0,populated:0};state.rows++;
              if(value!==null&&value!==''&&!(Array.isArray(value)&&!value.length))state.populated++;
              missingKeys.set(key,state);
            } else if(canonical(value)!==canonical(mirror.data[key])) differentKeys.set(key,(differentKeys.get(key)||0)+1);
          }
        }
        if(!body.pageInfo?.hasNextPage)break;
        if(!records.length||!body.pageInfo.endCursor||body.pageInfo.endCursor===cursor)throw new Error('TWENTY_PAGINATION_INCOMPLETE');
        cursor=body.pageInfo.endCursor;
      }
      if(pages>=1000)throw new Error('TWENTY_PAGE_LIMIT');
      print('fullComparison',{liveRecords:count,uniqueLiveRecords:liveIds.size,pages:pages+1,missingMirrorRecords:absent,differentOpportunityUpdatedAt:stale,
        activeMirrorsAbsentFromTwenty:stored.filter(r=>!r.deleted_at&&!liveIds.has(r.opportunity_id)).length,
        liveRecordsLocallyDeleted:stored.filter(r=>r.deleted_at&&liveIds.has(r.opportunity_id)).length,
        missingKeys:Object.fromEntries([...missingKeys].sort()),differentKeys:Object.fromEntries([...differentKeys].sort())});
      const paths=new Map();
      const walk=(value,parts)=>{
        if(Array.isArray(value))return value.forEach(v=>walk(v,[...parts,'[]']));
        if(value&&typeof value==='object')return Object.entries(value).forEach(([k,v])=>walk(v,[...parts,k]));
        if(typeof value!=='string'||!value)return;
        const email=/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value);
        const phone=/(?:^|[^A-Za-z0-9])\+?[0-9](?:[ .()\-]*[0-9]){9,14}(?:$|[^A-Za-z0-9])/.test(value);
        if(!email&&!phone)return;
        const key=parts.join('.');const state=paths.get(key)||{emails:0,phonePatterns:0};
        if(email)state.emails++;if(phone)state.phonePatterns++;paths.set(key,state);
      };
      for(const record of stored){walk(record.data,['data']);walk(record.last_note_text,['last_note_text']);}
      print('contactPatternPaths',Object.fromEntries([...paths].sort()));
    }
  }
}
inspect().catch(e=>{console.error(JSON.stringify({error:e.code||e.name,sqlState:e.meta?.code}));process.exitCode=1;}).finally(()=>db.$disconnect());
