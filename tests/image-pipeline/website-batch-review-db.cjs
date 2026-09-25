const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {PrismaClient}=require('@prisma/client');
const databaseUrl=require('../helpers/testDatabaseUrl')(process.env.TEST_DATABASE_URL);
const {normalizeAssessment}=require('../../src/utils/websiteImageAssessment.cjs');
const {applyResult,buildRequest,parseResult,MODEL}=require('../../scripts/lib/websiteImageBatchReview.cjs');
const prisma=new PrismaClient({datasources:{db:{url:databaseUrl}}});
const namespace=`sol-batch-test-${randomUUID()}`;
const raw={decision:'REVIEW',reasons:['UNCERTAIN_CONTACT'],scene:'OUTDOOR',qualityTier:'T2',qualityIssues:[],
    view:'EXTERIOR_FACADE',coverSuitable:false,decisionReason:'Small sign.',qualityReason:'Useful.',confidence:.7,evidence:[]};
const first=normalizeAssessment(raw,{sha256:'a'.repeat(64),width:1280,height:720,bytes:100,format:'jpeg'});
async function seed(suffix) {
    const [row]=await prisma.$queryRawUnsafe(`INSERT INTO labeled_warehouse_images
      ("warehouseId","imageUrl",classification,description,model,"webpUrl","jpegUrl","websiteStatus","websiteDecision",
       "websiteQualityTier","websiteAssessment","websiteAssessedAt")
      VALUES (930275,$1,'OUTDOOR','Original caption','scene-model','keep.webp','keep.jpeg','READY','REVIEW','T2',$2::jsonb,now()) RETURNING *`,
    `https://pub-94c0eb3cd2df4e71a1b6f5b73273bc71.r2.dev/${namespace}-${suffix}.jpg`,JSON.stringify(first.assessment));
    const snapshot={...row,websiteAssessedAt:row.websiteAssessedAt.toISOString()};
    snapshot.customId=buildRequest(snapshot).custom_id;
    const result=parseResult({custom_id:snapshot.customId,response:{status_code:200,request_id:'req_test',body:{
        id:'resp_test',model:MODEL,status:'completed',output:[{content:[{type:'output_text',
            text:JSON.stringify({...raw,decision:'ALLOW',reasons:[]})}]}]}}},snapshot,'batch_test');
    return {row,snapshot,result};
}
after(async()=>{
    await prisma.$executeRawUnsafe('DELETE FROM labeled_warehouse_images WHERE "imageUrl" LIKE $1',`%/${namespace}-%`);
    await prisma.$disconnect();
});
test('atomic import preserves every other column and complete first-pass assessment; replay is harmless',async()=>{
    const {row,snapshot,result}=await seed('apply');
    assert.equal(await applyResult(prisma,snapshot,result),1);
    assert.equal(await applyResult(prisma,snapshot,result),0);
    const [after]=await prisma.$queryRawUnsafe('SELECT * FROM labeled_warehouse_images WHERE id=$1',row.id);
    assert.equal(after.websiteDecision,'ALLOW');assert.equal(after.websiteAssessment.model,MODEL);
    assert.deepEqual(after.websiteAssessment.batchReview.prior.assessment,row.websiteAssessment);
    for(const key of Object.keys(row).filter(k=>!['websiteDecision','websiteQualityTier','websiteAssessment','websiteAssessedAt'].includes(k))) {
        assert.deepEqual(after[key],row[key],`Preserve ${key}`);
    }
});
test('a staff override added while the batch is running cannot be overwritten',async()=>{
    const {row,snapshot,result}=await seed('override');
    await prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images SET "websiteOverride"='{"decision":"BLOCK"}'::jsonb WHERE id=$1`,row.id);
    assert.equal(await applyResult(prisma,snapshot,result),0);
    const [after]=await prisma.$queryRawUnsafe('SELECT "websiteDecision","websiteOverride" FROM labeled_warehouse_images WHERE id=$1',row.id);
    assert.equal(after.websiteDecision,'REVIEW');assert.equal(after.websiteOverride.decision,'BLOCK');
});
test('changed source URL, assessment, timestamp or first-pass decision rejects stale results',async()=>{
    const changes=[`"imageUrl"="imageUrl"||'?changed=1'`,
        `"websiteAssessment"=jsonb_set("websiteAssessment",'{sourceSha256}',to_jsonb(repeat('b',64)))`,
        `"websiteAssessedAt"="websiteAssessedAt"+interval '1 second'`, `"websiteDecision"='BLOCK'`];
    for(const [i,change] of changes.entries()) {
        const {row,snapshot,result}=await seed(`stale-${i}`);
        await prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images SET ${change} WHERE id=$1`,row.id);
        assert.equal(await applyResult(prisma,snapshot,result),0,change);
    }
});
