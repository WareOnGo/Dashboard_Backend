const test = require('node:test');
const assert = require('node:assert/strict');
const { activationPolicy } = require('../../scripts/provisionWarehouseAnalytics');

function existingGrants() {
  return {
    ready:false,
    roles:[{rolname:'analytics_reader'},{rolname:'warehouse_analytics_owner'}],
    memberships:[],writableSchemas:[],
    reachableRelations:[
      {schema:'analytics',relation:'warehouse',can_read:true,can_write:false},
      {schema:'net',relation:'http_request_queue',can_read:true,can_write:true},
      {schema:'net',relation:'_http_response',can_read:true,can_write:true},
      {schema:'public',relation:'spatial_ref_sys',can_read:true,can_write:false},
    ],
    reachableDefiners:[{schema:'public',function:'st_estimatedextent',arguments:'text, text'}],
    blockers:['Unintended relation: net.http_request_queue (writable)'],
  };
}

test('direct SQL activation refuses inherited extension access', () => {
  assert.throws(() => activationPolicy(existingGrants()), /Activation refused/);
});

test('Data Studio activation keeps inherited access explicit', () => {
  const policy = activationPolicy(existingGrants(),true);
  assert.equal(policy.mode,'data-studio-only');
  assert.equal(policy.databaseIsolated,false);
  assert.equal(policy.inheritedAccess.length,1);
});

test('Data Studio mode rejects access to another business table', () => {
  const grants = existingGrants();
  grants.reachableRelations.push({schema:'public',relation:'Warehouse',can_read:true,can_write:false});
  assert.throws(() => activationPolicy(grants,true), /Unreviewed relation/);
});

test('Data Studio mode rejects new writes, role inheritance and privileged functions', () => {
  for (const mutate of [
    grants => { grants.reachableRelations[0].can_write = true; },
    grants => { grants.reachableRelations[3].can_write = true; },
    grants => { grants.memberships.push({role:'authenticated'}); },
    grants => { grants.writableSchemas.push({nspname:'public'}); },
    grants => { grants.roles[0].rolbypassrls = true; },
    grants => { grants.reachableDefiners.push({schema:'public',function:'export_contacts',arguments:''}); },
  ]) {
    const grants = existingGrants();
    mutate(grants);
    assert.throws(() => activationPolicy(grants,true));
  }
});
