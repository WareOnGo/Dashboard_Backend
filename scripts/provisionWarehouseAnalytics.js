// Inspect by default. --apply creates a disabled reader; --activate is separately
// gated by an effective-permission audit. --data-studio-only explicitly permits
// the reviewed extension grants for an owner-controlled reusable data source.
// Never log passwords or connection URLs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');

const READER = 'analytics_reader';
const OWNER = 'warehouse_analytics_owner';
const MARKER = 'wareongo.warehouse-analytics.v1:';

function clientFor(url) {
  const connection = new URL(url);
  connection.searchParams.set('connection_limit', '1');
  connection.searchParams.set('connect_timeout', '10');
  connection.searchParams.set('sslmode', 'require');
  return new PrismaClient({ datasources: { db: { url: connection.toString() } } });
}

async function preflight(db) {
  const context = await db.$queryRawUnsafe('SELECT current_database() AS db, current_user AS role');
  assert.deepEqual(context, [{ db: 'postgres', role: 'postgres' }], 'Expected the configured project postgres administrator');
  const roles = await db.$queryRawUnsafe(`SELECT rolname, rolcanlogin, rolsuper, rolcreatedb,
    rolcreaterole, rolreplication, rolbypassrls,
    shobj_description(oid, 'pg_authid') AS marker FROM pg_roles
    WHERE rolname IN ('analytics_reader', 'warehouse_analytics_owner')`);
  for (const role of roles) {
    assert.ok(role.marker?.startsWith(MARKER), `Refusing to reuse unrecognized role ${role.rolname}`);
    assert.ok(!role.rolsuper && !role.rolcreatedb && !role.rolcreaterole && !role.rolreplication
      && !role.rolbypassrls, 'Unexpected privileged analytics role');
    if (role.rolname === OWNER) assert.equal(role.rolcanlogin, false);
  }
  const schemas = await db.$queryRawUnsafe(`SELECT obj_description(oid,'pg_namespace') AS marker
    FROM pg_namespace WHERE nspname='analytics'`);
  if (schemas.length) assert.ok(schemas[0].marker?.startsWith(MARKER), 'Refusing to modify an unrecognized analytics schema');
  const views = await db.$queryRawUnsafe(`SELECT c.relname, obj_description(c.oid,'pg_class') AS marker
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='analytics' AND c.relname='warehouse'`);
  if (views.length) assert.ok(views[0].marker?.startsWith(MARKER), 'Refusing to replace an unrecognized view');
  return { roles, schemaExists: schemas.length > 0 };
}

async function audit(db) {
  const roles = await db.$queryRawUnsafe(`SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,
    rolcreaterole,rolreplication,rolbypassrls FROM pg_roles
    WHERE rolname IN ('analytics_reader','warehouse_analytics_owner') ORDER BY rolname`);
  if (!roles.some(role => role.rolname === READER)) return { ready: false, roles, blockers: ['Reader has not been created'] };
  const reachableRelations = await db.$queryRawUnsafe(`SELECT n.nspname AS schema,c.relname AS relation,
    has_any_column_privilege('analytics_reader',c.oid,'SELECT') AS can_read,
    has_table_privilege('analytics_reader',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS can_write
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT LIKE 'pg_%'
      AND n.nspname<>'information_schema' AND has_schema_privilege('analytics_reader',n.oid,'USAGE')
      AND (has_any_column_privilege('analytics_reader',c.oid,'SELECT')
        OR has_table_privilege('analytics_reader',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
    ORDER BY 1,2`);
  const memberships = await db.$queryRawUnsafe(`SELECT pg_get_userbyid(roleid) AS role
    FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='analytics_reader')`);
  const writableSchemas = await db.$queryRawUnsafe(`SELECT nspname FROM pg_namespace
    WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema'
      AND has_schema_privilege('analytics_reader',oid,'CREATE')`);
  const reachableDefiners = await db.$queryRawUnsafe(`SELECT n.nspname AS schema,p.proname AS function,
    pg_get_function_identity_arguments(p.oid) AS arguments
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog','information_schema')
      AND has_schema_privilege('analytics_reader',n.oid,'USAGE')
      AND has_function_privilege('analytics_reader',p.oid,'EXECUTE') ORDER BY 1,2,3`);
  const blockers = [];
  const intended = reachableRelations.find(row => row.schema === 'analytics' && row.relation === 'warehouse');
  if (!intended?.can_read || intended.can_write) blockers.push('The intended view does not have SELECT-only access');
  for (const row of reachableRelations) {
    if (row.schema !== 'analytics' || row.relation !== 'warehouse') {
      blockers.push(`Unintended relation: ${row.schema}.${row.relation}${row.can_write ? ' (writable)' : ''}`);
    }
  }
  if (memberships.length) blockers.push('Reader has unexpected role memberships');
  if (writableSchemas.length) blockers.push('Reader can create objects outside its temporary schema');
  if (reachableDefiners.length) blockers.push('Reader can execute privileged functions outside the view');
  for (const role of roles) {
    if (role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication || role.rolbypassrls) {
      blockers.push(`Unexpected administrative attributes on ${role.rolname}`);
    }
  }
  return { ready: blockers.length === 0, roles, reachableRelations, memberships, writableSchemas, reachableDefiners, blockers };
}

async function expectDenied(db, label, sql, allowedStates = ['42501']) {
  try {
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE analytics_reader');
      await tx.$queryRawUnsafe(sql);
    });
  } catch (error) {
    if (allowedStates.includes(error.meta?.code)) return label;
    throw error;
  }
  throw new Error(`Expected permission denied: ${label}`);
}

async function verify(db) {
  const view = await db.$queryRawUnsafe(`SELECT pg_get_userbyid(c.relowner) AS owner,c.reloptions
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='analytics' AND c.relname='warehouse' AND c.relkind='v'`);
  assert.equal(view.length, 1, 'Joined view is missing');
  assert.equal(view[0].owner, OWNER);
  assert.ok(view[0].reloptions.includes('security_barrier=true'));
  assert.ok(view[0].reloptions.includes('security_invoker=false'));
  const columns = await db.$queryRawUnsafe(`SELECT column_name,data_type FROM information_schema.columns
    WHERE table_schema='analytics' AND table_name='warehouse' ORDER BY ordinal_position`);
  const forbidden = new Set(['contactNumber','contact_number','alt_phone_number','googleLocation','google_location',
    'latitude','longitude','geog','embedding','address','contactPerson','contact_person','ownerCompanyName',
    'owner_company_name','ownerAltPoc','owner_alt_poc','uploadedBy','uploaded_by','otherSpecifications',
    'other_specifications','scoutNotes','scout_notes','ai_description','media','photos','photosWebp','scoutVoiceNotes']);
  assert.ok(columns.length > 0 && columns.every(column => !forbidden.has(column.column_name)));
  assert.ok(columns.every(column => !['ARRAY','USER-DEFINED','json','jsonb'].includes(column.data_type)), 'BI output must use supported scalar types');
  for (const name of ['id','warehouse_data_id','warehouseType','warehouseOwnerType','totalSpaceSqft','micromarket','fireNocAvailable']) {
    assert.ok(columns.some(column => column.column_name === name), `Missing original source column: ${name}`);
  }
  const counts = await db.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE analytics_reader');
    return tx.$queryRawUnsafe(`SELECT count(*)::int AS rows,count(DISTINCT id)::int AS unique_warehouses,
      count(*) FILTER(WHERE NOT has_warehouse_data)::int AS missing_data,
      count(*) FILTER(WHERE NOT has_phone)::int AS missing_phone,
      count(*) FILTER(WHERE NOT has_google_location)::int AS missing_google_location,
      count(*) FILTER(WHERE NOT has_coordinates)::int AS missing_coordinates FROM analytics.warehouse`);
  });
  const expected = await db.$queryRawUnsafe(`SELECT count(*)::int AS rows,
    count(*) FILTER(WHERE d.id IS NULL)::int AS missing_data,
    count(*) FILTER(WHERE NULLIF(btrim(w."contactNumber", E' \\t\\r\\n'),'') IS NULL)::int AS missing_phone,
    count(*) FILTER(WHERE NULLIF(btrim(w."googleLocation", E' \\t\\r\\n'),'') IS NULL)::int AS missing_google_location,
    count(*) FILTER(WHERE d.latitude IS NULL OR d.longitude IS NULL)::int AS missing_coordinates
    FROM public."Warehouse" w LEFT JOIN public."WarehouseData" d ON d."warehouseId"=w.id`);
  assert.equal(counts[0].unique_warehouses, expected[0].rows, 'Join duplicated or omitted warehouses');
  for (const key of Object.keys(expected[0])) assert.equal(counts[0][key], expected[0][key], `Mismatch: ${key}`);
  const denied = [];
  for (const [label,sql,states] of [
    ['original warehouse table','SELECT "contactNumber" FROM public."Warehouse" LIMIT 0'],
    ['original warehouse data table','SELECT latitude,longitude FROM public."WarehouseData" LIMIT 0'],
    ['employee table','SELECT phone_number FROM public."VerifiedNumber" LIMIT 0'],
    ['auth users','SELECT id FROM auth.users LIMIT 0'],
    ['view update','UPDATE analytics.warehouse SET city=city WHERE false RETURNING id',['42501','55000']],
  ]) denied.push(await expectDenied(db,label,sql,states));
  const exposure = await db.$queryRawUnsafe(`SELECT r.rolname,
    has_schema_privilege(r.oid,'analytics','USAGE') AND has_table_privilege(r.oid,'analytics.warehouse','SELECT') AS exposed
    FROM pg_roles r WHERE rolname IN ('anon','authenticated','service_role')`);
  assert.ok(exposure.every(role => !role.exposed), 'View was granted to a Supabase API role');
  return { counts: counts[0], columnCount: columns.length, denied, apiRolesDenied: exposure.map(role => role.rolname), security: await audit(db) };
}

async function apply(db) {
  await preflight(db);
  const statements = fs.readFileSync(path.join(__dirname,'sql/warehouseAnalytics.sql'),'utf8')
    .split('-- statement-breakpoint').map(statement => statement.trim()).filter(Boolean);
  await db.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout='3s'");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout='30s'");
    for (const [index,sql] of statements.entries()) {
      try { await tx.$executeRawUnsafe(sql); }
      catch (error) { error.safeStage = index + 1; throw error; }
    }
  }, { timeout: 60000 });
  return verify(db);
}

// Update only the existing view. Renaming preserves its OID, column positions,
// owner, and ACL; compare every row before committing this naming migration.
async function updateView(db) {
  await preflight(db);
  const statements = fs.readFileSync(path.join(__dirname,'sql/warehouseAnalytics.sql'),'utf8')
    .split('-- statement-breakpoint').map(statement => statement.trim()).filter(Boolean);
  const start = statements.findIndex(sql => sql === 'SET LOCAL ROLE warehouse_analytics_owner;');
  const end = statements.findIndex(sql => sql.startsWith('REVOKE ALL ON analytics.warehouse'));
  assert.ok(start >= 0 && end > start, 'View-only SQL section is missing');
  const result = await db.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout='3s'");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout='30s'");
    const describe = () => tx.$queryRawUnsafe(`SELECT oid::text,relowner::text,relacl::text,reloptions
      FROM pg_class WHERE oid='analytics.warehouse'::regclass AND relkind='v'`);
    const beforeDefinition = await describe();
    assert.equal(beforeDefinition.length, 1, 'Existing warehouse view is required');
    const columns = await tx.$queryRawUnsafe(`SELECT attname FROM pg_attribute
      WHERE attrelid='analytics.warehouse'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`);
    const key = columns.some(column => column.attname === 'id') ? 'id' : 'warehouse_id';
    const snapshot = column => tx.$queryRawUnsafe(`SELECT count(*)::int AS rows,
      count(DISTINCT v."${column}")::int AS unique_ids,
      md5(string_agg(md5(v::text),'' ORDER BY v."${column}")) AS fingerprint FROM analytics.warehouse v`);
    const before = await snapshot(key);
    for (const sql of statements.slice(start,end)) await tx.$executeRawUnsafe(sql);
    await tx.$executeRawUnsafe('RESET ROLE');
    assert.deepEqual(await snapshot('id'), before, 'Column update changed warehouse values');
    assert.deepEqual(await describe(), beforeDefinition, 'Column update changed view ownership or grants');
    const afterColumns = await tx.$queryRawUnsafe(`SELECT attname FROM pg_attribute
      WHERE attrelid='analytics.warehouse'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`);
    assert.equal(afterColumns.length, columns.length, 'Column update changed the field count');
    return {rows:before[0].rows,valuesUnchanged:true,ownerAndGrantsUnchanged:true,
      renamedColumns:columns.filter((column,index)=>column.attname!==afterColumns[index].attname).length};
  }, {timeout:60000,isolationLevel:'RepeatableRead'});
  return {migration:result,verification:await verify(db)};
}

function activationPolicy(security, dataStudioOnly = false) {
  if (security.ready) return { mode: dataStudioOnly ? 'data-studio-only' : 'direct-sql', databaseIsolated: true };
  assert.ok(dataStudioOnly, 'Activation refused: inherited permissions still allow access outside analytics.warehouse');
  // These are the existing PUBLIC grants reviewed with the administrator. This
  // exception relies on Data Studio source permissions, not SQL-role isolation.
  // No other relations, memberships, writable schemas or definers are accepted.
  assert.equal(security.memberships.length, 0, 'Unexpected reader membership');
  assert.equal(security.writableSchemas.length, 0, 'Unexpected schema CREATE permission');
  assert.equal(security.roles.length, 2, 'Expected both analytics roles');
  for (const role of security.roles) {
    assert.ok(!role.rolsuper && !role.rolcreatedb && !role.rolcreaterole && !role.rolreplication
      && !role.rolbypassrls, 'Unexpected administrative attributes');
  }
  const allowedRelations = new Map([
    ['analytics.warehouse', false],
    ['net._http_response', true], ['net.http_request_queue', true],
    ['public.geography_columns', false], ['public.geometry_columns', false], ['public.spatial_ref_sys', false],
  ]);
  const intended = security.reachableRelations.find(row => row.schema === 'analytics' && row.relation === 'warehouse');
  assert.ok(intended?.can_read && !intended.can_write, 'Expected SELECT-only access to the warehouse view');
  for (const row of security.reachableRelations) {
    const name = `${row.schema}.${row.relation}`;
    assert.ok(allowedRelations.has(name) && (!row.can_write || allowedRelations.get(name)),
      `Unreviewed relation access: ${name}`);
  }
  const allowedDefiners = new Set([
    'public.rls_auto_enable()',
    'public.st_estimatedextent(text, text)',
    'public.st_estimatedextent(text, text, text)',
    'public.st_estimatedextent(text, text, text, boolean)',
  ]);
  for (const fn of security.reachableDefiners) {
    assert.ok(allowedDefiners.has(`${fn.schema}.${fn.function}(${fn.arguments})`), 'Unreviewed privileged function');
  }
  return { mode: 'data-studio-only', databaseIsolated: false, inheritedAccess: security.blockers };
}

async function activate(db, credentialsFile, dataStudioOnly = false) {
  assert.ok(credentialsFile, 'Provide --credentials-file with a private local output path');
  await preflight(db);
  const checks = await verify(db);
  const policy = activationPolicy(checks.security, dataStudioOnly);
  assert.equal(checks.security.roles.find(role => role.rolname === READER).rolcanlogin, false,
    'Reader is already active; refusing an implicit password rotation');
  const password = crypto.randomBytes(32).toString('base64url');
  const connection = new URL(process.env.DATABASE_URL);
  const isSharedPooler = connection.hostname.endsWith('.pooler.supabase.com');
  const projectRef = decodeURIComponent(connection.username).split('.').slice(1).join('.');
  if (isSharedPooler) assert.ok(projectRef, 'Cannot derive pooler project reference');
  connection.username = isSharedPooler ? `${READER}.${projectRef}` : READER;
  connection.password = password;
  if (isSharedPooler) connection.port = '5432';
  connection.search = '?sslmode=require';
  const output = { host: connection.hostname,port: Number(connection.port || 5432),database: connection.pathname.slice(1),
    username: decodeURIComponent(connection.username),password,ssl: true,schema:'analytics',view:'warehouse',
    customQuery:'SELECT * FROM analytics.warehouse',connectionString: connection.toString(),
    accessPolicy:policy,
    sharing:dataStudioOnly ? 'Keep these credentials and the reusable data source private. Share only the report with the analyst.' : undefined };
  const fd = fs.openSync(path.resolve(credentialsFile),'wx',0o600);
  let activated = false;
  try {
    fs.writeFileSync(fd,JSON.stringify(output,null,2)+'\n');
    fs.fsyncSync(fd);
    // Generated base64url contains no quotes. Never accept user-supplied SQL here.
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`ALTER ROLE analytics_reader LOGIN PASSWORD '${password}'`);
      const description = dataStudioOnly ? 'owner-controlled Data Studio login; PUBLIC extension grants remain; do not share credentials'
        : 'restricted BI login';
      await tx.$executeRawUnsafe(`COMMENT ON ROLE analytics_reader IS '${MARKER} ${description}'`);
    });
    activated = true;
    const readerDb = clientFor(connection.toString());
    try {
      const actual = await readerDb.$queryRawUnsafe('SELECT current_user AS role,count(*)::int AS rows FROM analytics.warehouse');
      assert.equal(actual[0].role,READER);
      assert.equal(actual[0].rows,checks.counts.rows);
      // Check real authentication as well as the SET ROLE tests above.
      for (const sql of [
        'SELECT "contactNumber" FROM public."Warehouse" LIMIT 0',
        'SELECT latitude,longitude FROM public."WarehouseData" LIMIT 0',
        'SELECT phone_number FROM public."VerifiedNumber" LIMIT 0',
        'SELECT id FROM auth.users LIMIT 0',
      ]) {
        await assert.rejects(() => readerDb.$queryRawUnsafe(sql), error => error.meta?.code === '42501');
      }
      const wrapped = await readerDb.$queryRawUnsafe('SELECT count(*)::int AS rows FROM (SELECT * FROM analytics.warehouse) AS report_data');
      assert.equal(wrapped[0].rows, actual[0].rows);
      const defaults = await readerDb.$queryRawUnsafe("SELECT current_setting('default_transaction_read_only') AS read_only");
      assert.equal(defaults[0].read_only, 'on');
    } finally { await readerDb.$disconnect(); }
    return { activated:true,credentialsFile:path.resolve(credentialsFile),rows:checks.counts.rows,
      accessPolicy:policy,authenticatedChecks:['joined view','Data Studio query wrapper','raw tables denied','read-only default'] };
  } catch (error) {
    if (activated) await db.$executeRawUnsafe('ALTER ROLE analytics_reader NOLOGIN');
    throw error;
  } finally { fs.closeSync(fd); }
}

module.exports = { preflight, audit, verify, apply, updateView, activationPolicy, activate };
if (require.main === module) {
  require('dotenv').config({path:path.resolve(__dirname,'../.env'),quiet:true});
  const db = clientFor(process.env.DATABASE_URL);
  const args = process.argv.slice(2);
  const credentialsIndex = args.indexOf('--credentials-file');
  const run = args.includes('--activate')
    ? () => activate(db,credentialsIndex >= 0 ? args[credentialsIndex+1] : undefined,args.includes('--data-studio-only'))
    : args.includes('--update-view') ? () => updateView(db)
      : args.includes('--apply') ? () => apply(db)
      : args.includes('--verify') ? () => verify(db)
        : async () => ({ preflight:await preflight(db),security:await audit(db) });
  run().then(result => console.log(JSON.stringify(result,null,2)))
    .catch(error => { console.error(JSON.stringify({error:'WAREHOUSE_ANALYTICS_FAILED',code:error.code,sqlState:error.meta?.code,stage:error.safeStage,
      detail:args.includes('--activate') ? undefined : error.meta?.message,
      reason:error instanceof assert.AssertionError ? error.message : undefined}));process.exitCode=1; })
    .finally(() => db.$disconnect());
}
