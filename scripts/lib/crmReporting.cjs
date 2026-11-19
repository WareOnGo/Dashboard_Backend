const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const VIEWS=['crm_report','crm_stage_transitions'];
const SQL_FILE=path.resolve(__dirname,'../sql/crmReporting.sql');
const CREDENTIALS=path.resolve(__dirname,'../../.env.crm-analytics.credentials.json');

async function historicalFingerprint(db,maxId) {
  const [row]=await db.$queryRawUnsafe(`SELECT count(*)::int AS rows,max(id)::text AS max_id,
    md5(string_agg(row_to_json(t)::text,',' ORDER BY id)) AS fingerprint
    FROM public.stage_transitions t WHERE ($1::bigint IS NULL OR id <= $1::bigint)`,maxId??null);
  return row;
}

async function testStageCalculations(db,asReader) {
  // Exercise the actual view SELECT against synthetic JSON rows, with no writes
  // to live tables and no second implementation of the stage-duration algorithm.
  const ddl=fs.readFileSync(SQL_FILE,'utf8').split('-- statement-breakpoint')
    .find(s=>s.includes('CREATE OR REPLACE VIEW analytics.crm_stage_transitions'));
  let query=ddl.slice(ddl.indexOf('AS\nWITH ranked')+3).trim().replace(/;$/,'');
  query=query.replace('FROM public.stage_transitions t',`FROM jsonb_to_recordset($1::jsonb) AS t
    (id bigint,opportunity_id text,from_stage text,to_stage text,changed_at timestamptz,detected_at timestamptz)`);
  query=query.replace('LEFT JOIN analytics.crm_report d',`LEFT JOIN jsonb_to_recordset($2::jsonb) AS d
    (opportunity_id text,opportunity_name text,company_name text,city text,primary_assignees text,
     secondary_assignee text,internal_assignee_emails text,stage text,is_deleted boolean)`);
  const change=(id,opportunity_id,from_stage,to_stage,day,detectedDay=day)=>({id,opportunity_id,from_stage,to_stage,
    changed_at:`2026-01-${String(day).padStart(2,'0')}T00:00:00Z`,detected_at:`2026-01-${String(detectedDay).padStart(2,'0')}T00:00:00Z`});
  const events=[change(1,'a','A','B',2),change(2,'a','A','B',2,3),change(3,'a','B','C',5),
    change(4,'b','A','B',3),change(5,'b','C','D',9),change(6,'orphan','A','B',2),change(7,'deleted','A','B',2)];
  const deals=[{opportunity_id:'a',stage:'C',is_deleted:false},{opportunity_id:'b',stage:'Z',is_deleted:false},
    {opportunity_id:'deleted',stage:'B',is_deleted:true}];
  const rows=await asReader(db,query,JSON.stringify(events),JSON.stringify(deals));
  assert.equal(rows.length,events.length,'History view lost transitions');
  const byId=new Map(rows.map(r=>[r.transition_id,r]));
  assert.equal(byId.get('1').days_in_to_stage.toString(),'3');
  assert.equal(byId.get('1').duration_basis,'between_observed_transitions');
  assert.equal(byId.get('2').is_duplicate,true);
  assert.equal(byId.get('2').days_in_to_stage,null);
  assert.equal(byId.get('3').is_current_stage_entry,true);
  assert.equal(byId.get('3').observed_transition_number,2);
  assert.equal(byId.get('4').duration_basis,'gap_in_observed_history');
  assert.equal(byId.get('4').days_in_to_stage,null);
  assert.equal(byId.get('5').duration_basis,'unknown_exit');
  assert.equal(byId.get('6').has_opportunity_record,false);
  assert.equal(byId.get('6').is_current_stage_entry,false);
  assert.equal(byId.get('7').days_in_to_stage,null);
  return {cases:7,checks:['duplicate exclusion','contiguous duration','current stage','history gaps','unknown exits','orphan retention','deleted deal']};
}

async function verify(db,{verifyBase,asReader,clientFor}) {
  const base=await verifyBase(db);
  const crmViews=['crm_opportunities','crm_notes','crm_tasks',...VIEWS];
  const separation=await db.$queryRawUnsafe(`SELECT rolname,
    has_any_column_privilege(oid,'analytics.warehouse','SELECT') AS warehouse_access,
    pg_has_role(oid,'warehouse_analytics_owner','MEMBER') AS warehouse_owner_member,
    pg_has_role(oid,'crm_analytics_owner','MEMBER') AS crm_owner_member,
    pg_has_role(oid,CASE WHEN rolname='analytics_reader' THEN 'crm_analytics_reader' ELSE 'analytics_reader' END,'MEMBER') AS other_reader_member
    FROM pg_roles WHERE rolname IN ('analytics_reader','crm_analytics_reader') ORDER BY rolname`);
  assert.equal(separation.length,2);
  for(const role of separation) {
    assert.equal(role.warehouse_access,role.rolname==='analytics_reader','Warehouse access is not separate');
    assert.ok(!role.warehouse_owner_member&&!role.crm_owner_member&&!role.other_reader_member,'Unexpected cross-role membership');
  }
  // Check actual queries as the warehouse role, including column-level grants.
  await db.$transaction(async tx=>{
    await tx.$executeRawUnsafe('SET LOCAL ROLE analytics_reader');
    await tx.$queryRawUnsafe('SELECT * FROM analytics.warehouse LIMIT 0');
  });
  for(const view of crmViews) {
    const [permission]=await db.$queryRawUnsafe(`SELECT has_any_column_privilege('analytics_reader',$1,'SELECT') AS readable`,`analytics.${view}`);
    assert.equal(permission.readable,false,'Warehouse analyst has access to CRM columns');
    await assert.rejects(()=>db.$transaction(async tx=>{
      await tx.$executeRawUnsafe('SET LOCAL ROLE analytics_reader');
      return tx.$queryRawUnsafe(`SELECT * FROM analytics.${view} LIMIT 0`);
    }),e=>e.meta?.code==='42501');
  }
  const definitions=await db.$queryRawUnsafe(`SELECT relname,pg_get_userbyid(relowner) AS owner,reloptions
    FROM pg_class WHERE relnamespace='analytics'::regnamespace AND relname IN ('crm_report','crm_stage_transitions') AND relkind='v'`);
  assert.equal(definitions.length,2);
  assert.ok(definitions.every(v=>v.owner==='crm_analytics_owner'&&v.reloptions.includes('security_barrier=true')&&v.reloptions.includes('security_invoker=false')));
  const columns=await db.$queryRawUnsafe(`SELECT table_name,column_name,data_type FROM information_schema.columns
    WHERE table_schema='analytics' AND table_name IN ('crm_report','crm_stage_transitions') ORDER BY table_name,ordinal_position`);
  const accepted=new Set(['text','integer','bigint','numeric','boolean','date','timestamp with time zone','timestamp without time zone']);
  assert.ok(columns.every(c=>accepted.has(c.data_type)),'Reporting view contains a Data Studio-incompatible type');
  const [{number,invalid_number,list,empty_list,invalid_date,iso_date}]=await asReader(db,`SELECT
    analytics.crm_report_number('50,000.50')::text AS number,analytics.crm_report_number('5-10 lakh')::text AS invalid_number,
    analytics.crm_report_text('["A","B"]'::jsonb) AS list,analytics.crm_report_text('[]'::jsonb) AS empty_list,
    analytics.crm_report_date('2026-02-31')::text AS invalid_date,analytics.crm_report_date('2026-10-08T12:00:00Z')::text AS iso_date`);
  assert.equal(number,'50000.50');assert.equal(invalid_number,null);assert.equal(list,'A, B');
  assert.equal(empty_list,null);assert.equal(invalid_date,null);assert.equal(iso_date,'2026-10-08');
  const stageFixtures=await testStageCalculations(db,asReader);
  const [source]=await db.$queryRawUnsafe(`SELECT (SELECT count(*)::int FROM public.opportunities) AS deals,
    (SELECT count(*)::int FROM public.opportunities WHERE deleted_at IS NULL) AS current_deals,
    (SELECT count(*)::int FROM public.stage_transitions) AS log_rows,
    (SELECT count(DISTINCT (opportunity_id,from_stage,to_stage,changed_at))::int FROM public.stage_transitions) AS unique_events`);
  const [report]=await asReader(db,`SELECT count(*)::int AS rows,count(DISTINCT opportunity_id)::int AS unique_ids,
    count(*) FILTER(WHERE NOT is_deleted)::int AS current_deals,
    sum(stage_log_row_count)::int AS log_rows,sum(observed_stage_change_count)::int AS unique_events
    FROM (SELECT * FROM analytics.crm_report) AS data_studio`);
  assert.equal(report.rows,source.deals);assert.equal(report.unique_ids,source.deals);
  assert.equal(report.current_deals,source.current_deals);
  assert.equal(report.log_rows,source.log_rows);assert.equal(report.unique_events,source.unique_events);
  const [stage]=await asReader(db,`SELECT count(*)::int AS rows,count(DISTINCT transition_id)::int AS unique_ids,
    count(*) FILTER(WHERE NOT is_duplicate)::int AS canonical_events,
    count(*) FILTER(WHERE is_duplicate)::int AS duplicate_rows,
    count(*) FILTER(WHERE days_in_to_stage<0)::int AS negative_durations
    FROM (SELECT * FROM analytics.crm_stage_transitions) AS data_studio`);
  assert.equal(stage.rows,source.log_rows);assert.equal(stage.unique_ids,source.log_rows);
  assert.equal(stage.canonical_events,source.unique_events);assert.equal(stage.negative_durations,0);
  const [joined]=await asReader(db,`SELECT count(*)::int AS rows FROM analytics.crm_stage_transitions t
    LEFT JOIN analytics.crm_report d USING (opportunity_id)`);
  assert.equal(joined.rows,stage.rows,'Reporting join multiplied transitions');
  const [correspondence]=await asReader(db,`SELECT
    count(*) FILTER(WHERE r.has_client_phone IS DISTINCT FROM o.has_client_phone OR r.has_client_email IS DISTINCT FROM o.has_client_email)::int AS flag_mismatches,
    count(*) FILTER(WHERE r.note_count<>jsonb_array_length(o.notes) OR r.task_count<>jsonb_array_length(o.tasks))::int AS linked_count_mismatches,
    count(*) FILTER(WHERE r.primary_assignees IS DISTINCT FROM analytics.crm_report_text(o.assigned_to)
      OR r.secondary_assignee IS DISTINCT FROM o.secondary_assignee)::int AS user_assignment_mismatches
    FROM analytics.crm_report r JOIN analytics.crm_opportunities o USING (opportunity_id)`);
  assert.ok(Object.values(correspondence).every(n=>n===0),'Reporting view disagrees with the masked raw view');
  const [leaks]=await asReader(db,`SELECT count(*)::int AS matches FROM analytics.crm_report r
    CROSS JOIN LATERAL jsonb_each(to_jsonb(r)) AS e(key,value)
    WHERE jsonb_typeof(e.value)='string' AND e.key NOT IN
      ('primary_assignees','secondary_assignee','internal_assignee_emails','owner_name','internal_owner_email',
       'created_by_name','updated_by_name','last_meaningful_update_by')
    AND e.value#>>'{}' ~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+[.][A-Z]{2,}'`);
  assert.equal(leaks.matches,0,'Client email pattern exposed in scalar reporting fields');
  for(const view of VIEWS) {
    await assert.rejects(()=>asReader(db,`DELETE FROM analytics.${view} WHERE false RETURNING 1`),e=>['42501','55000'].includes(e.meta?.code));
    const permissions=await db.$queryRawUnsafe(`SELECT rolname,has_table_privilege(oid,$1,'SELECT') AS exposed
      FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')`,`analytics.${view}`);
    assert.ok(permissions.every(p=>!p.exposed),'Reporting view granted to a Supabase API role');
  }
  let authenticated=false;
  if(fs.existsSync(CREDENTIALS)) {
    const credentials=JSON.parse(fs.readFileSync(CREDENTIALS,'utf8'));
    const reader=clientFor(credentials.connectionString);
    try {
      for(const view of VIEWS)await reader.$queryRawUnsafe(`SELECT * FROM analytics.${view} LIMIT 1`);
      authenticated=true;
    }finally{await reader.$disconnect();}
  }
  return {views:VIEWS,columnCounts:Object.fromEntries(VIEWS.map(v=>[v,columns.filter(c=>c.table_name===v).length])),
    opportunities:report,transitions:stage,scalarTypesOnly:true,maskingPassed:true,stageFixtures,authenticated,
    rawAccessDenied:base.rawAccessDenied,apiRolesDenied:true,analystRolesSeparate:true,knownExtensionLimitation:base.security.limitation};
}

async function apply(db,helpers) {
  await helpers.preflight(db);
  const before=await historicalFingerprint(db);
  const statements=fs.readFileSync(SQL_FILE,'utf8').split('-- statement-breakpoint');
  await db.$transaction(async tx=>{
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout='3s'");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout='30s'");
    for(const [index,sql] of statements.entries()) {
      if(!sql.trim())continue;
      try{await tx.$executeRawUnsafe(sql);}catch(e){e.safeStage=`reporting:${index+1}`;throw e;}
    }
  },{timeout:60000});
  const result=await verify(db,helpers);
  const after=await historicalFingerprint(db,before.max_id);
  assert.equal(after.fingerprint,before.fingerprint,'Existing stage history changed');
  assert.equal(after.rows,before.rows);
  if(fs.existsSync(CREDENTIALS)) {
    const credentials=JSON.parse(fs.readFileSync(CREDENTIALS,'utf8'));
    credentials.views=[...new Set([...credentials.views,...VIEWS])];
    credentials.dataStudioQueries={opportunities:'SELECT * FROM analytics.crm_report WHERE NOT is_deleted',
      stageTransitions:'SELECT * FROM analytics.crm_stage_transitions WHERE NOT is_duplicate'};
    fs.writeFileSync(CREDENTIALS,JSON.stringify(credentials,null,2)+'\n',{mode:0o600});
    fs.chmodSync(CREDENTIALS,0o600);
  }
  return {...result,existingStageRowsPreserved:before.rows};
}

module.exports={apply,verify};
