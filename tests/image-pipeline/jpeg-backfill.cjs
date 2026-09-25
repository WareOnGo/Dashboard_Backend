const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const sharp=require('sharp');
const {PrismaClient}=require('@prisma/client');
const {migrateJpeg}=require('../../scripts/migrateImageJpeg');
const testDatabaseUrl=require('../helpers/testDatabaseUrl');
const {JPEG_FIELDS}=require('../../scripts/lib/jpegPilot');
const {options}=require('../../scripts/backfillJpegVariants');
const {reusable,complete,versionFor,maxEdge,REUSE_VERSION,PHOTO_VERSION,DOCUMENT_VERSION,
    publish,decoder,pool,semaphore,publishBatch,batchPublisher}=require('../../scripts/lib/jpegBackfill');
const prisma=new PrismaClient({datasources:{db:{url:testDatabaseUrl(process.env.TEST_DATABASE_URL)}}});
const url='https://fixture.r2.dev/raw.jpg';
let tmp;
before(async()=>{await migrateJpeg(prisma,true);tmp=await fs.mkdtemp(path.join(os.tmpdir(),'jpeg-backfill-test-'));});
beforeEach(async()=>{
    await prisma.$executeRawUnsafe('TRUNCATE "Warehouse",labeled_warehouse_images RESTART IDENTITY CASCADE');
    await prisma.$executeRawUnsafe(`INSERT INTO "Warehouse" (id,media,photos) VALUES (1,$1::jsonb,$2)`,JSON.stringify({images:[url],docs:['original.pdf']}),url);
    await prisma.$executeRawUnsafe(`INSERT INTO labeled_warehouse_images ("warehouseId","imageUrl",classification,description)
      VALUES(1,$1,'INDOOR','Preserve this caption')`,url);
});
after(async()=>{await prisma.$disconnect();await fs.rm(tmp,{recursive:true,force:true});});
const row=async()=>({...((await prisma.$queryRawUnsafe(`SELECT id,"imageUrl",classification::text AS classification,"jpegUrl","jpegVersion","jpegStatus","jpegAt"
    FROM labeled_warehouse_images ORDER BY id LIMIT 1`))[0]),warehouseIds:[1]});
const snapshot=async()=>prisma.$queryRawUnsafe(`SELECT to_jsonb(w) AS w,to_jsonb(l) AS l FROM "Warehouse" w JOIN labeled_warehouse_images l ON w.id=l."warehouseId"`);
const withoutJpeg=o=>Object.fromEntries(Object.entries(o).filter(([k])=>!JPEG_FIELDS.includes(k)));

test('reuse validates actual JPEG format, size, orientation, dimensions and colour space',()=>{
    const m={format:'jpeg',width:1280,height:960,space:'srgb'};
    assert.ok(reusable(m,180000,1280,url));
    for(const changed of [{format:'webp'},{width:1600},{orientation:6},{space:'cmyk'},{pages:2}])assert.equal(reusable({...m,...changed},180000,1280,url),false);
    assert.equal(reusable(m,300000,1280,url),false);
    assert.ok(reusable(m,300000,1280,url,{smallOnly:false}));
    assert.equal(reusable(m,180000,1280,'https://fixture.r2.dev/raw.png'),false);
    assert.equal(maxEdge({classification:'INDOOR'}),1280);assert.equal(maxEdge({classification:'DOCUMENT'}),1920);
    assert.equal(versionFor({classification:'INDOOR'}),PHOTO_VERSION);assert.equal(versionFor({classification:'DOCUMENT'}),DOCUMENT_VERSION);
    assert.ok(complete({classification:'INDOOR',jpegStatus:'READY',jpegUrl:url,imageUrl:url,jpegVersion:REUSE_VERSION}));
    assert.equal(complete({classification:'INDOOR',jpegStatus:'READY',jpegUrl:url,jpegVersion:DOCUMENT_VERSION}),false);
    assert.equal(options(['--inventory=fixture.json','--workers=16']).workers,16);
    for(const workers of [0,17,100])assert.throws(()=>options(['--inventory=fixture.json',`--workers=${workers}`]));
});

test('same original URL publication preserves all existing image and warehouse fields and rejects stale writers',async()=>{
    const original=await snapshot();const r=await row();
    assert.ok(await publish(prisma,r,{url,bytes:123456,version:REUSE_VERSION}));
    const updated=await snapshot();
    assert.deepEqual(updated[0].w,original[0].w);assert.deepEqual(withoutJpeg(updated[0].l),withoutJpeg(original[0].l));
    assert.equal(updated[0].l.jpegUrl,url);assert.equal(updated[0].l.jpegStatus,'READY');
    assert.equal(await publish(prisma,r,{url:'https://fixture.r2.dev/other.jpg',bytes:123,version:PHOTO_VERSION}),false);
    assert.deepEqual(await snapshot(),updated);
    const current=await row();await prisma.$executeRawUnsafe(`UPDATE "Warehouse" SET media='{"images":[]}'::jsonb,photos=NULL`);
    assert.equal(await publish(prisma,current,{url,bytes:234,version:PHOTO_VERSION}),false);
});

test('unexpected changes to protected fields roll back the whole publication statement',async()=>{
    const before=await snapshot();
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_jpeg_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.description='unexpected'; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER test_jpeg_mutation BEFORE UPDATE ON labeled_warehouse_images FOR EACH ROW EXECUTE FUNCTION test_jpeg_mutation()`);
    try{
        await assert.rejects(publish(prisma,await row(),{url,bytes:123,version:REUSE_VERSION}));
        assert.deepEqual(await snapshot(),before);
    }finally{
        await prisma.$executeRawUnsafe('DROP TRIGGER test_jpeg_mutation ON labeled_warehouse_images');
        await prisma.$executeRawUnsafe('DROP FUNCTION test_jpeg_mutation()');
    }
});

test('native worker preserves originals, rotates/resizes JPEG, and rejects corrupt files',async()=>{
    const input=path.join(tmp,'large.jpg'),output=path.join(tmp,'small.jpg');
    await sharp({create:{width:3000,height:2000,channels:3,background:'#246'}}).jpeg().withMetadata({orientation:6}).toFile(input);
    const before=await fs.readFile(input);const signal=new AbortController().signal;
    const result=await decoder(input,output,'compress',1280,signal);
    assert.equal(result.width,853);assert.equal(result.height,1280);
    const m=await sharp(output).metadata();assert.equal(m.format,'jpeg');assert.equal(m.isProgressive,true);assert.equal(m.chromaSubsampling,'4:2:0');
    assert.equal(m.orientation,undefined);assert.deepEqual(await fs.readFile(input),before);
    assert.ok((await decoder(output,path.join(tmp,'unused'),'inspect',1280,signal)).ok);
    await fs.writeFile(path.join(tmp,'bad'),'broken');await assert.rejects(decoder(path.join(tmp,'bad'),output,'inspect',1280,signal),/source_decode_failed/);
});

test('batched publication preserves rows independently and skips stale entries',async()=>{
    const r=await row();const snapshotBefore=await snapshot();
    const second='https://fixture.r2.dev/second.jpg';
    await prisma.$executeRawUnsafe(`UPDATE "Warehouse" SET media=$1::jsonb`,JSON.stringify({images:[url,second]}));
    await prisma.$executeRawUnsafe(`INSERT INTO labeled_warehouse_images ("warehouseId","imageUrl",classification) VALUES(1,$1,'OUTDOOR')`,second);
    const [r2]=await prisma.$queryRawUnsafe(`SELECT id,"imageUrl",classification::text AS classification,"jpegUrl","jpegVersion","jpegStatus","jpegAt"
      FROM labeled_warehouse_images WHERE "imageUrl"=$1`,second);
    r2.warehouseIds=[1];
    const updated=await publishBatch(prisma,[{row:{...r,jpegStatus:'FAILED'},result:{url,bytes:100,version:REUSE_VERSION}},
        {row:r2,result:{url:second,bytes:200,version:REUSE_VERSION}}]);
    assert.deepEqual([...updated],[r2.id]);
    const batch=batchPublisher(prisma,2,5);
    assert.equal(await batch(r,{url,bytes:100,version:REUSE_VERSION}),true);
    const images=await prisma.$queryRawUnsafe(`SELECT to_jsonb(l) AS l FROM labeled_warehouse_images l ORDER BY id`);
    assert.deepEqual(withoutJpeg(images[0].l),withoutJpeg(snapshotBefore[0].l));
    assert.equal(images[0].l.jpegUrl,url);assert.equal(images[1].l.jpegUrl,second);
    await assert.rejects(publishBatch(prisma,[{row:r,result:{}},{row:r,result:{}}]),/invalid_jpeg_batch/);
});

test('network pool and decoder gate remain bounded and await in-flight work on failure',async()=>{
    let active=0,maximum=0,finished=0;const gate=semaphore(2);
    await pool(Array.from({length:25},(_,i)=>i),6,()=>gate(async()=>{
        active++;maximum=Math.max(maximum,active);await new Promise(r=>setTimeout(r,5));active--;finished++;
    }),new AbortController().signal);
    assert.equal(maximum,2);assert.equal(finished,25);assert.equal(active,0);
    await assert.rejects(pool([0,1,2,3],2,async n=>{if(n===0)throw Error('stop');active++;await new Promise(r=>setTimeout(r,5));active--;},new AbortController().signal));
    assert.equal(active,0);
});
