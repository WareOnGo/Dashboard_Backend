const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {PrismaClient}=require('@prisma/client');
const databaseUrl=require('../helpers/testDatabaseUrl')(process.env.TEST_DATABASE_URL);
const {migrateWebsiteApproval}=require('../../scripts/migrateWebsiteImageApproval');
const {ImagePipelineRepository}=require('../../src/models/imagePipelineRepository.cjs');
const {normalizeAssessment}=require('../../src/utils/websiteImageAssessment.cjs');
const prisma=new PrismaClient({datasources:{db:{url:databaseUrl}}});
const repository=new ImagePipelineRepository(prisma);
const namespace=`website-test-${Date.now()}`;
const owner=930001;
const assessment=normalizeAssessment({decision:'ALLOW',reasons:[],scene:'INDOOR',qualityTier:'T2',qualityIssues:[],
    view:'INTERIOR_OVERVIEW',coverSuitable:true,decisionReason:'No contacts.',qualityReason:'Useful.',confidence:.9,evidence:[]},
    {sha256:'a'.repeat(64),width:1280,height:720,bytes:100,format:'jpeg'});
async function seed(suffix){
    const [row]=await prisma.$queryRawUnsafe(`INSERT INTO labeled_warehouse_images ("warehouseId","imageUrl",classification,description,model)
      VALUES ($1,$2,'INDOOR','Preserved caption','original-model') RETURNING *`,owner,`https://fixture.r2.dev/${namespace}-${suffix}.jpg`);
    return row;
}
before(async()=>{await migrateWebsiteApproval(prisma,true);});
after(async()=>{
    await prisma.$executeRawUnsafe('DELETE FROM labeled_warehouse_images WHERE "imageUrl" LIKE $1',`https://fixture.r2.dev/${namespace}-%`);
    await prisma.$executeRawUnsafe('DELETE FROM "Warehouse" WHERE id=$1',owner);
    await prisma.$disconnect();
});
test('migration is additive, repeatable and proves old values/media preserved',async()=>{
    const r=await migrateWebsiteApproval(prisma,true);assert.equal(r.oldColumnsPreserved,true);assert.equal(r.mediaPreserved,true);
});
test('concurrent claims are disjoint, fenced, and leave source labels/manual override intact',async()=>{
    const first=await seed('a'),second=await seed('b');
    await prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images SET "webpUrl"='https://fixture.r2.dev/keep.webp',
      "jpegUrl"='https://fixture.r2.dev/keep.jpeg' WHERE id IN ($1,$2)`,first.id,second.id);
    await prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images SET "websiteOverride"='{"decision":"BLOCK","reason":"Staff hold"}'::jsonb WHERE id=$1`,first.id);
    const claims=await Promise.all([repository.claim('website',{limit:1,warehouseId:owner,allEntries:true}),
        repository.claim('website',{limit:1,warehouseId:owner,allEntries:true})]);
    const [a,b]=claims.flat();assert.notEqual(a.id,b.id);
    assert.equal(await repository.complete('website',{...a,websiteClaimToken:'wrong'},assessment),0);
    assert.equal(await repository.complete('website',a,assessment),1);assert.equal(await repository.complete('website',b,assessment),1);
    const rows=await prisma.$queryRawUnsafe('SELECT * FROM labeled_warehouse_images WHERE id IN ($1,$2)',first.id,second.id);
    for(const r of rows){assert.equal(r.classification,'INDOOR');assert.equal(r.description,'Preserved caption');assert.equal(r.model,'original-model');assert.equal(r.websiteStatus,'READY');
        assert.equal(r.webpUrl,'https://fixture.r2.dev/keep.webp');assert.equal(r.jpegUrl,'https://fixture.r2.dev/keep.jpeg');}
    assert.equal(rows.find(r=>r.id===first.id).websiteOverride.decision,'BLOCK');
    assert.equal((await repository.claim('website',{limit:1,warehouseId:owner,allEntries:true})).length,0);
});
test('stale leases cannot publish; expired work can be reclaimed; failures retry independently',async()=>{
    const r=await seed('retry');const [old]=await repository.claim('website',{limit:1,warehouseId:owner,allEntries:true});
    await prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images SET "websiteLeaseUntil"=now()-interval '1 minute' WHERE id=$1`,r.id);
    assert.equal(await repository.complete('website',old,assessment),0);
    const [fresh]=await repository.claim('website',{limit:1,warehouseId:owner,allEntries:true});assert.notEqual(fresh.websiteClaimToken,old.websiteClaimToken);
    await repository.fail('website',fresh,'model_timeout');
    assert.equal((await repository.claim('website',{limit:1,warehouseId:owner,allEntries:true})).length,0);
    const [state]=await prisma.$queryRawUnsafe('SELECT * FROM labeled_warehouse_images WHERE id=$1',r.id);
    assert.equal(state.websiteStatus,'FAILED');assert.equal(state.websiteDecision,'PENDING');assert.equal(state.description,'Preserved caption');
    await prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images SET "websiteNextAttemptAt"=now()-interval '1 second' WHERE id=$1`,r.id);
    const [retry]=await repository.claim('website',{limit:1,warehouseId:owner,allEntries:true});
    assert.equal(await repository.complete('website',retry,assessment),1);
});
test('schema rejects READY without valid assessment metadata',async()=>{
    const r=await seed('constraint');
    await assert.rejects(prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images SET "websiteStatus"='READY',"websiteDecision"='ALLOW' WHERE id=$1`,r.id));
});
test('existing registration forward-fills website work and cron claims only current media independently of labels',async()=>{
    const active=await seed('active'),retained=await seed('retained');
    const newUrl=`https://fixture.r2.dev/${namespace}-new.jpg`;
    const media=JSON.stringify({images:[active.imageUrl,newUrl],videos:['https://fixture.r2.dev/keep.mp4']});
    await prisma.$executeRawUnsafe('INSERT INTO "Warehouse" (id,media,visibility) VALUES ($1,$2::jsonb,true)',owner,media);
    await repository.register(owner);
    const [fresh]=await prisma.$queryRawUnsafe('SELECT * FROM labeled_warehouse_images WHERE "imageUrl"=$1',newUrl);
    assert.equal(fresh.websiteStatus,'PENDING');assert.equal(fresh.websiteDecision,'PENDING');assert.equal(fresh.labelStatus,'PENDING');
    const labels=await repository.claim('label',{limit:10,warehouseId:owner});
    // The label lease is still RUNNING while the independent website work starts.
    const websites=await repository.claim('website',{limit:10,warehouseId:owner});
    assert.deepEqual(labels.map(r=>r.id),[fresh.id]);
    assert.deepEqual(websites.map(r=>r.id).sort((a,b)=>a-b),[active.id,fresh.id].sort((a,b)=>a-b));
    assert.ok(!websites.some(r=>r.id===retained.id));
    for(const row of websites)await repository.complete('website',row,assessment);
    const [after]=await prisma.$queryRawUnsafe('SELECT * FROM labeled_warehouse_images WHERE id=$1',fresh.id);
    assert.equal(after.classification,null);assert.equal(after.labelStatus,'RUNNING');assert.equal(after.labelClaimToken,labels[0].labelClaimToken);
    const [warehouse]=await prisma.$queryRawUnsafe('SELECT media FROM "Warehouse" WHERE id=$1',owner);
    assert.deepEqual(warehouse.media,JSON.parse(media));
});
