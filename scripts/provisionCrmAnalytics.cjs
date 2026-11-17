// CRM views + separate SQL login. Never print passwords or raw CRM records.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {PrismaClient}=require('@prisma/client');
const MARKER='wareongo.crm-analytics.v1:';
const READER='crm_analytics_reader';
const OWNER='crm_analytics_owner';
const VIEWS=['crm_opportunities','crm_notes','crm_tasks'];
const REPORT_VIEWS=['crm_report','crm_stage_transitions'];

function clientFor(url) {
  const connection=new URL(url);
  connection.searchParams.set('connection_limit','1');
  connection.searchParams.set('connect_timeout','10');
  connection.searchParams.set('sslmode','require');
  return new PrismaClient({datasources:{db:{url:connection.toString()}}});
}

async function preflight(db) {
  assert.deepEqual(await db.$queryRawUnsafe('SELECT current_database() AS db,current_user AS role'),[{db:'postgres',role:'postgres'}]);
  const roles=await db.$queryRawUnsafe(`SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
    shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname IN ('crm_analytics_reader','crm_analytics_owner')`);
  for(const role of roles) {
    assert.ok(role.marker?.startsWith(MARKER),'Unrecognized pre-existing CRM role');
    assert.ok(!role.rolsuper&&!role.rolcreatedb&&!role.rolcreaterole&&!role.rolreplication&&!role.rolbypassrls);
    if(role.rolname===OWNER)assert.equal(role.rolcanlogin,false);
  }
  const [schema]=await db.$queryRawUnsafe("SELECT obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname='analytics'");
  assert.ok(schema?.marker?.startsWith('wareongo.warehouse-analytics.v1:'),'Expected the existing private analytics schema');
  const existing=await db.$queryRawUnsafe(`SELECT c.relname,obj_description(c.oid,'pg_class') AS marker FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='analytics' AND c.relname IN ('crm_opportunities','crm_notes','crm_tasks','crm_report','crm_stage_transitions')
    UNION ALL SELECT p.proname,obj_description(p.oid,'pg_proc') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='analytics' AND p.proname IN ('crm_mask_text','crm_mask_json','crm_report_number','crm_report_text','crm_report_date')`);
  for(const object of existing)assert.ok(object.marker?.startsWith(MARKER),'Unrecognized pre-existing CRM analytics object');
  const sources=await db.$queryRawUnsafe(`SELECT relname,relrowsecurity FROM pg_class WHERE oid IN
    ('public.opportunities'::regclass,'public.stage_transitions'::regclass,'public.crm_records'::regclass)`);
  assert.equal(sources.length,3);assert.ok(sources.every(s=>s.relrowsecurity));
  return {roles,sourceTables:sources};
}

async function audit(db) {
  const relations=await db.$queryRawUnsafe(`SELECT n.nspname AS schema,c.relname AS relation,
    has_any_column_privilege('${READER}',c.oid,'SELECT') AS can_read,
    has_table_privilege('${READER}',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS can_write
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
      AND has_schema_privilege('${READER}',n.oid,'USAGE')
      AND (has_any_column_privilege('${READER}',c.oid,'SELECT') OR has_table_privilege('${READER}',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) ORDER BY 1,2`);
  const memberships=await db.$queryRawUnsafe(`SELECT pg_get_userbyid(roleid) AS role FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='${READER}')`);
  assert.equal(memberships.length,0,'Unexpected reader membership');
  const writableSchemas=await db.$queryRawUnsafe(`SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema' AND has_schema_privilege('${READER}',oid,'CREATE')`);
  assert.equal(writableSchemas.length,0,'Unexpected reader schema CREATE privilege');
  const definers=await db.$queryRawUnsafe(`SELECT n.nspname AS schema,p.proname AS function,pg_get_function_identity_arguments(p.oid) AS arguments
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog','information_schema')
    AND has_schema_privilege('${READER}',n.oid,'USAGE') AND has_function_privilege('${READER}',p.oid,'EXECUTE') ORDER BY 1,2,3`);
  // Existing PUBLIC grants were reviewed and accepted in this session for BI access.
  const allowed=new Map([...[...VIEWS,...REPORT_VIEWS].map(v=>[`analytics.${v}`,false]),
    ['net.http_request_queue',true],['net._http_response',true],
    ['public.geometry_columns',false],['public.geography_columns',false],['public.spatial_ref_sys',false]]);
  for(const r of relations)assert.ok(allowed.has(`${r.schema}.${r.relation}`)&&(!r.can_write||allowed.get(`${r.schema}.${r.relation}`)),`Unreviewed access: ${r.schema}.${r.relation}`);
  for(const view of VIEWS)assert.ok(relations.some(r=>r.schema==='analytics'&&r.relation===view&&r.can_read&&!r.can_write));
  const allowedDefiners=new Set(['public.rls_auto_enable()','public.st_estimatedextent(text, text)',
    'public.st_estimatedextent(text, text, text)','public.st_estimatedextent(text, text, text, boolean)']);
  for(const fn of definers)assert.ok(allowedDefiners.has(`${fn.schema}.${fn.function}(${fn.arguments})`),'Unreviewed SECURITY DEFINER function');
  return {relations,definers,memberships,writableSchemas,databaseIsolated:false,
    limitation:'Previously reviewed PUBLIC pg_net grants remain; this login is not isolated from net.http_request_queue and net._http_response.'};
}

async function asReader(db,sql,...values) {
  return db.$transaction(async tx=>{
    await tx.$executeRawUnsafe('SET LOCAL ROLE crm_analytics_reader');
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout='60s'");
    return tx.$queryRawUnsafe(sql,...values);
  },{timeout:90000});
}

const DENIED_SQL=[
  'SELECT data FROM public.opportunities LIMIT 0',
  'SELECT data FROM public.crm_records LIMIT 0',
  'SELECT * FROM public.stage_transitions LIMIT 0',
  'SELECT "contactNumber" FROM public."Warehouse" LIMIT 0',
  'SELECT phone_number FROM public."VerifiedNumber" LIMIT 0',
  'SELECT id FROM auth.users LIMIT 0',
  'SELECT * FROM vault.decrypted_secrets LIMIT 0',
  'SELECT * FROM analytics.warehouse LIMIT 0',
];

async function verify(db) {
  await preflight(db);
  const definitions=await db.$queryRawUnsafe(`SELECT relname,pg_get_userbyid(relowner) AS owner,reloptions FROM pg_class
    WHERE relnamespace='analytics'::regnamespace AND relname IN ('crm_opportunities','crm_notes','crm_tasks') AND relkind='v'`);
  assert.equal(definitions.length,3);
  assert.ok(definitions.every(v=>v.owner===OWNER&&v.reloptions.includes('security_barrier=true')&&v.reloptions.includes('security_invoker=false')));
  const fixture={
    id:'deadbeef-1234-1234-1234-123456789012',createdAt:'2026-10-08T00:00:00Z',budget:'123456789012',position:12,
    pocPhoneNumber:{primaryPhoneNumber:'9876543210',primaryPhoneCallingCode:'+91',additionalPhones:[{number:'9876501234',countryCode:'IN'}]},
    companyEmail:{primaryEmail:'client@example.test',additionalEmails:['extra@example.test']},
    companyName:'Client client@example.test',description:'Call +91 98765 43210 or client@example.test',
    pointOfContact:{name:{firstName:'Client',lastName:'Name'},emails:{primaryEmail:'person@example.test'},phones:{primaryPhoneNumber:'9123456789'},searchVector:"'client':1 'example.test':2 '9123456789':3"},
    searchVector:"'client':1 'example.test':2",secondaryAssignee:'secondary@wareongo.com',
    owner:{userEmail:'staff@wareongo.com',name:{firstName:'Employee'},searchVector:'staff@wareongo.com'},
    createdBy:{name:'Employee',workspaceMemberId:'internal-user',context:null},
    bodyV2:{markdown:'Email customer@example.test. Call 9876543210',blocknote:'[{"text":"Phone +91-9876543210"}]'},
    emptyEmail:'',phone:null,hasPhone:true,amount:{amountMicros:123456789012,currencyCode:'INR'},
    timelineActivities:[{properties:{diff:{budget:{before:'123456789012',after:'223456789012'},pocPhoneNumber:{before:{primaryPhoneNumber:'9123456789'},after:{primaryPhoneNumber:'9876543210'}}}}}],
  };
  const [{masked}]=await asReader(db,'SELECT analytics.crm_mask_json($1::jsonb) AS masked',JSON.stringify(fixture));
  for(const key of ['id','createdAt','budget','position','secondaryAssignee','owner','createdBy','emptyEmail','phone','hasPhone','amount'])assert.deepEqual(masked[key],fixture[key],`Mask changed non-contact field ${key}`);
  assert.deepEqual(masked.pointOfContact.name,fixture.pointOfContact.name);
  assert.equal(masked.pocPhoneNumber.primaryPhoneCallingCode,'+91');
  assert.deepEqual(masked.timelineActivities[0].properties.diff.budget,fixture.timelineActivities[0].properties.diff.budget);
  for(const secret of ['client@example.test','extra@example.test','person@example.test','customer@example.test','9876543210','9876501234','9123456789','98765 43210']) {
    assert.ok(!JSON.stringify(masked).includes(secret),'Synthetic contact was not redacted');
  }
  const counts={};
  for(const view of VIEWS) {
    const [row]=await asReader(db,`SELECT count(*)::int AS rows,sum(octet_length(data::text))::bigint::text AS json_bytes FROM analytics.${view}`);
    counts[view]=row;
  }
  const [rawCounts]=await db.$queryRawUnsafe(`SELECT (SELECT count(*)::int FROM public.opportunities) AS opportunities,
    (SELECT count(*)::int FROM public.crm_records WHERE object='notes') AS notes,
    (SELECT count(*)::int FROM public.crm_records WHERE object='tasks') AS tasks`);
  for(const type of ['opportunities','notes','tasks'])assert.equal(counts[`crm_${type}`].rows,rawCounts[type]);
  for(const sql of DENIED_SQL)await assert.rejects(()=>asReader(db,sql),e=>e.meta?.code==='42501');
  for(const view of VIEWS)await assert.rejects(()=>asReader(db,`DELETE FROM analytics.${view} WHERE false RETURNING 1`),e=>['42501','55000'].includes(e.meta?.code));
  const exposure=await db.$queryRawUnsafe(`SELECT rolname,has_table_privilege(oid,'analytics.crm_opportunities','SELECT')
    OR has_table_privilege(oid,'analytics.crm_notes','SELECT') OR has_table_privilege(oid,'analytics.crm_tasks','SELECT') AS exposed
    FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')`);
  assert.ok(exposure.every(r=>!r.exposed),'CRM view accidentally granted to a Supabase API role');
  return {counts,maskingFixturesPassed:true,rawAccessDenied:DENIED_SQL.length,apiRolesDenied:true,security:await audit(db)};
}

async function apply(db) {
  await preflight(db);
  const sql=fs.readFileSync(path.join(__dirname,'sql/crmAnalytics.sql'),'utf8');
  await db.$transaction(async tx=>{
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout='3s'");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout='30s'");
    for(const [index,statement] of sql.split('-- statement-breakpoint').entries()) {
      if(!statement.trim())continue;
      try {await tx.$executeRawUnsafe(statement);}catch(e){e.safeStage=index+1;throw e;}
    }
  },{timeout:60000});
  return verify(db);
}

async function activate(db,file) {
  assert.ok(file,'Provide a private credentials file');
  const checks=await verify(db);
  const [role]=await db.$queryRawUnsafe("SELECT rolcanlogin FROM pg_roles WHERE rolname='crm_analytics_reader'");
  assert.equal(role.rolcanlogin,false,'Already active; refusing an implicit password rotation');
  const password=crypto.randomBytes(32).toString('base64url');
  const connection=new URL(process.env.DATABASE_URL);
  const pooler=connection.hostname.endsWith('.pooler.supabase.com');
  const project=decodeURIComponent(connection.username).split('.').slice(1).join('.');
  if(pooler)assert.ok(project);
  connection.username=pooler?`${READER}.${project}`:READER;
  connection.password=password;
  if(pooler)connection.port='5432';
  connection.search='?sslmode=require';
  const credentials={host:connection.hostname,port:Number(connection.port||5432),database:connection.pathname.slice(1),
    username:decodeURIComponent(connection.username),password,ssl:true,schema:'analytics',views:VIEWS,
    connectionString:connection.toString(),accessPolicy:checks.security.limitation};
  const fd=fs.openSync(path.resolve(file),'wx',0o600);
  let active=false;
  try {
    fs.writeFileSync(fd,JSON.stringify(credentials,null,2)+'\n');fs.fsyncSync(fd);
    await db.$executeRawUnsafe(`ALTER ROLE crm_analytics_reader LOGIN PASSWORD '${password}'`);
    active=true;
    const reader=clientFor(connection.toString());
    try {
      const [who]=await reader.$queryRawUnsafe('SELECT current_user AS role');assert.equal(who.role,READER);
      for(const view of VIEWS)await reader.$queryRawUnsafe(`SELECT data FROM analytics.${view} LIMIT 1`);
      for(const sql of DENIED_SQL)await assert.rejects(()=>reader.$queryRawUnsafe(sql),e=>e.meta?.code==='42501');
      const [defaults]=await reader.$queryRawUnsafe("SELECT current_setting('default_transaction_read_only') AS read_only");
      assert.equal(defaults.read_only,'on');
    }finally{await reader.$disconnect();}
    return {activated:true,credentialsFile:path.resolve(file),views:VIEWS,counts:checks.counts,authenticatedChecksPassed:true,limitation:checks.security.limitation};
  }catch(e){if(active)await db.$executeRawUnsafe('ALTER ROLE crm_analytics_reader NOLOGIN');throw e;}
  finally{fs.closeSync(fd);}
}

module.exports={preflight,audit,apply,verify,activate,asReader,clientFor};
if(require.main===module) {
  require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
  const db=clientFor(process.env.DATABASE_URL);
  const args=process.argv.slice(2);
  const reporting=require('./lib/crmReporting.cjs');
  const run=args.includes('--apply-reporting')?()=>reporting.apply(db,{preflight,verifyBase:verify,asReader,clientFor}):args.includes('--verify-reporting')?()=>reporting.verify(db,{verifyBase:verify,asReader,clientFor}):args.includes('--apply')?()=>apply(db):args.includes('--activate')?()=>activate(db,args[args.indexOf('--credentials-file')+1]):args.includes('--verify')?()=>verify(db):()=>preflight(db);
  run().then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{
    console.error(JSON.stringify({error:'CRM_ANALYTICS_FAILED',errorType:e.name,code:e.code,sqlState:e.meta?.code,stage:e.safeStage,
      location:e.stack?.split('\n').find(line=>/^\s+at /.test(line)),
      reason:e instanceof assert.AssertionError?e.message:undefined}));process.exitCode=1;
  }).finally(()=>db.$disconnect());
}
