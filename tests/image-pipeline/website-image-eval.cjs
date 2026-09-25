const {test}=require('node:test');
const assert=require('node:assert/strict');
const {selectGallery,chooseSample,effectiveAssessment}=require('../../scripts/lib/websiteImageEvaluation.cjs');
const row=(id,scene='INDOOR',qualityTier='T1',extra={})=>({id,order:id,originalUrl:`https://fixture.test/${id}.jpg`,
    assessment:{decision:'ALLOW',reasons:[],scene,qualityTier,view:scene==='INDOOR'?'INTERIOR_OVERVIEW':'EXTERIOR_FACADE',coverSuitable:true,...extra}});

test('privacy blocks and uncertain/pending/failed images never fill the minimum',()=>{
    const rows=[row(1),row(2,'OUTDOOR','T1',{decision:'BLOCK',reasons:['TO_LET_SIGN']}),
        row(3,'OUTDOOR','T1',{decision:'REVIEW'}),{id:4}, {...row(5),error:'timeout'},
        row(6,'INDOOR','T1',{reasons:['CONTACT_NUMBER']})];
    assert.deepEqual(selectGallery(rows).ids,[1]);assert.equal(selectGallery(rows).belowTarget,true);
});
test('documents and unusable images do not fill a quota',()=>{
    assert.equal(selectGallery([row(1,'DOCUMENT'),row(2,'INDOOR','UNUSABLE')]).count,0);
});
test('existing scene labels drive the split and a new opinion never revives a document',()=>{
    const result=selectGallery([{...row(1,'OUTDOOR'),previousScene:'INDOOR'},
        {...row(2,'INDOOR'),previousScene:'DOCUMENT'}]);
    assert.equal(result.indoor,1);assert.equal(result.outdoor,0);assert.deepEqual(result.ids,[1]);
});
test('maximum eight good photos balances four indoor/four outdoor where available',()=>{
    const rows=Array.from({length:20},(_,i)=>row(i,i<12?'INDOOR':'OUTDOOR',i<12?'T1':'T2'));
    const result=selectGallery(rows);assert.equal(result.count,8);assert.equal(result.indoor,4);assert.equal(result.outdoor,4);
});
test('a missing scene reallocates slots instead of dropping useful photos',()=>{
    const rows=Array.from({length:10},(_,i)=>row(i,'OUTDOOR'));const result=selectGallery(rows);
    assert.equal(result.count,8);assert.equal(result.indoor,0);assert.equal(result.outdoor,8);
});
test('a shortage on one side can give a useful 3/5 split',()=>{
    const rows=Array.from({length:12},(_,i)=>row(i,i<3?'INDOOR':'OUTDOOR'));const result=selectGallery(rows);
    assert.equal(result.indoor,3);assert.equal(result.outdoor,5);
});
test('weak photos fill only a sparse gallery, not spare slots up to eight',()=>{
    const good=Array.from({length:5},(_,i)=>row(i));const weak=Array.from({length:8},(_,i)=>row(i+10,'OUTDOOR','T3'));
    assert.equal(selectGallery([...good,...weak]).count,5);assert.equal(selectGallery([...good,...weak]).fallbackCount,0);
    const sparse=selectGallery([...good.slice(0,2),...weak]);assert.equal(sparse.count,4);assert.equal(sparse.fallbackCount,2);
});
test('a weak but safe gallery remains usable and does not invent additional images',()=>{
    assert.equal(selectGallery([row(1,'INDOOR','T3')]).count,1);
    assert.equal(selectGallery(Array.from({length:10},(_,i)=>row(i,'INDOOR','T3'))).count,4);
});
test('duplicate groups keep the better approved image, never a blocked representative',()=>{
    const rows=[{...row(1,'INDOOR','T3'),duplicateGroup:'same'},
        {...row(2),duplicateGroup:'same'}, {...row(3,'INDOOR','T1',{decision:'BLOCK'}),duplicateGroup:'same'}];
    assert.deepEqual(selectGallery(rows).ids,[2]);
});
test('overall views outrank washrooms as the cover and ordering is deterministic',()=>{
    const rows=[row(1,'INDOOR','T1',{view:'WASHROOM',coverSuitable:false}),row(2,'OUTDOOR','T2')];
    assert.deepEqual(selectGallery(rows).ids,[2,1]);assert.deepEqual(selectGallery(rows),selectGallery(rows));
});
test('invalid bounds are rejected rather than changing selection semantics',()=>{
    assert.throws(()=>selectGallery([],{minimum:8,maximum:4}));
});
test('sample selection is deterministic and bounded',()=>{
    const inventory={warehouses:[{id:1,visibility:true,originalUrls:['https://fixture.test/1.jpg']}],
        images:[{id:1,imageUrl:'https://fixture.test/1.jpg',classification:'INDOOR'}]};
    assert.deepEqual(chooseSample(inventory),chooseSample(inventory));assert.equal(chooseSample(inventory).images.length,1);
});
test('a clear thumbnail is fallback-only despite a top-tier model opinion',()=>{
    const tiny={...row(1),local:{width:319,height:196}};
    assert.equal(effectiveAssessment(tiny).qualityTier,'T3');
    assert.equal(effectiveAssessment(tiny).coverSuitable,false);
    assert.equal(selectGallery([tiny]).fallbackCount,1);
    assert.equal(row(1).assessment.qualityTier,'T1');
    assert.equal(tiny.assessment.qualityTier,'T1');
});
test('dimension guards can only lower quality and never approve unsafe photos',()=>{
    assert.equal(effectiveAssessment({...row(1),local:{width:800,height:600}}).qualityTier,'T2');
    assert.equal(effectiveAssessment({...row(1,'INDOOR','UNUSABLE'),local:{width:300,height:200}}).qualityTier,'UNUSABLE');
    assert.equal(selectGallery([{...row(1,'INDOOR','T1',{decision:'BLOCK'}),local:{width:1600,height:1200}}]).count,0);
});
test('narrow portrait images can be useful but do not take the cover from a sufficient wide photo',()=>{
    const portrait={...row(1),local:{width:500,height:1200}};
    const landscape={...row(2),local:{width:1280,height:720}};
    assert.equal(effectiveAssessment(portrait).coverSuitable,false);
    assert.deepEqual(selectGallery([portrait,landscape]).ids,[2,1]);
});
test('a clear small fallback beats blurry photos when filling a sparse gallery',()=>{
    const good=[row(1),row(2),row(3)];
    const blurry=row(4,'OUTDOOR','T3');
    const smallClear={...row(5,'INDOOR','T2'),local:{width:400,height:550}};
    assert.deepEqual(selectGallery([...good,blurry,smallClear]).ids,[1,2,3,5]);
});
