const {test}=require('node:test');
const assert=require('node:assert/strict');
const {MODEL,buildRequest,parseResult,indexResults,verifySource}=require('../../scripts/lib/websiteImageBatchReview.cjs');
const {normalizeAssessment}=require('../../src/utils/websiteImageAssessment.cjs');
const {createHash}=require('node:crypto');
const original=Buffer.from('original fixture bytes');
const hash=createHash('sha256').update(original).digest('hex');
const raw={decision:'REVIEW',reasons:['UNCERTAIN_CONTACT'],scene:'OUTDOOR',qualityTier:'T2',qualityIssues:[],
    view:'EXTERIOR_FACADE',coverSuitable:false,decisionReason:'Small sign.',qualityReason:'Useful image.',confidence:.7,evidence:[]};
const first=normalizeAssessment(raw,{sha256:hash,width:1280,height:720,bytes:original.length,format:'jpeg'});
const snapshot={id:123,imageUrl:'https://pub-94c0eb3cd2df4e71a1b6f5b73273bc71.r2.dev/raw.jpg',
    webpUrl:'https://invalid.test/variant.webp',jpegUrl:'https://invalid.test/variant.jpg',
    websiteStatus:'READY',websiteDecision:'REVIEW',websiteQualityTier:'T2',websiteAssessment:first.assessment,
    websiteAssessedAt:'2026-09-25T10:00:00.000Z'};
snapshot.customId=buildRequest(snapshot).custom_id;
function line(result={...raw,decision:'ALLOW',reasons:[],confidence:.95}) {
    return {custom_id:snapshot.customId,response:{status_code:200,request_id:'req_fixture',body:{id:'resp_fixture',
        model:MODEL,status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(result)}]}],
        usage:{input_tokens:200,output_tokens:100}}},error:null};
}
test('batch uses Sol, original URL, same policy and structured outputs without first-pass anchoring',()=>{
    const request=buildRequest(snapshot);
    assert.equal(request.method,'POST');assert.equal(request.url,'/v1/responses');assert.equal(request.body.model,MODEL);
    assert.equal(request.body.input[0].content[1].image_url,snapshot.imageUrl);assert.equal(request.body.input[0].content[1].detail,'high');
    assert.equal(request.body.text.format.strict,true);assert.equal(request.body.store,false);
    assert.ok(!JSON.stringify(request).includes('Small sign.'));
    assert.throws(()=>buildRequest({...snapshot,websiteDecision:'ALLOW'}),/not_a_ready_review/);
    assert.throws(()=>buildRequest({...snapshot,imageUrl:'http://127.0.0.1/private'}),/unsupported_source_host/);
});
test('reviews preserve first assessment and provenance while applying existing guards',()=>{
    const result=parseResult(line(),snapshot,'batch_fixture');
    assert.equal(result.decision,'ALLOW');assert.equal(result.assessment.model,MODEL);
    assert.equal(result.assessment.batchReview.prior.assessment.model,'gpt-5.6-luna');
    assert.deepEqual(result.assessment.batchReview.prior.assessment,first.assessment);
    const guarded=parseResult(line({...raw,decision:'ALLOW'}),snapshot,'batch_fixture');
    assert.equal(guarded.decision,'REVIEW');assert.ok(guarded.assessment.guards.includes('inconsistent_allow'));
    assert.equal(first.assessment.decision,'REVIEW');
});
test('failed, incomplete, wrong-model, refused and invalid responses cannot approve an image',()=>{
    for (const modify of [r=>{r.error={code:'bad_image'};},r=>{r.response.status_code=429;},
        r=>{r.response.body.status='incomplete';},r=>{r.response.body.model='gpt-5.6-luna';},
        r=>{r.response.body.output[0].content=[{type:'refusal',refusal:'No'}];},
        r=>{r.response.body.output[0].content[0].text='{}';}]) {
        const value=line();modify(value);assert.throws(()=>parseResult(value,snapshot,'batch_fixture'));
    }
});
test('unordered outputs match IDs and reject unknown/duplicate identities',()=>{
    const second={...snapshot,id:124};second.customId=buildRequest(second).custom_id;
    const a=line(),b={...line(),custom_id:second.customId};
    const matched=indexResults([JSON.stringify(b)+'\n'+JSON.stringify(a)+'\n'],[snapshot,second]);
    assert.equal(matched.get(snapshot.customId),matched.get(a.custom_id));assert.equal(matched.size,2);
    assert.throws(()=>indexResults([JSON.stringify(a)+'\n'+JSON.stringify(a)],[snapshot]),/duplicate_result_id/);
    assert.throws(()=>indexResults([JSON.stringify(b)],[snapshot]),/unknown_result_id/);
});
test('changed original bytes cannot be submitted or applied under a stale source hash',async()=>{
    const http=async()=>new Response(original,{status:200});
    assert.equal((await verifySource(snapshot,http)).bytes,original.length);
    await assert.rejects(verifySource(snapshot,async()=>new Response('different pixels')),/source_changed/);
});
test('download-failure retries attach exactly the hashed original and record their transport',()=>{
    const request=buildRequest(snapshot,{originalBytes:original});
    assert.equal(request.custom_id,snapshot.customId);
    assert.equal(request.body.input[0].content[1].image_url,`data:image/jpeg;base64,${original.toString('base64')}`);
    assert.throws(()=>buildRequest(snapshot,{originalBytes:Buffer.from('different bytes')}),/source_changed/);
    const result=parseResult(line(),{...snapshot,batchInputTransport:'original-bytes',retryOfBatchId:'batch_parent'},'batch_retry');
    assert.equal(result.assessment.inputTransport,'original-bytes');
    assert.equal(result.assessment.batchReview.retryOfBatchId,'batch_parent');
    assert.equal(result.assessment.batchReview.prior.assessment.model,'gpt-5.6-luna');
});

function preparedDirectory() {
    const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
    const {VERSION,PROMPT,sha256}=require('../../scripts/lib/websiteImageBatchReview.cjs');
    const output=fs.mkdtempSync(path.join(os.tmpdir(),'website-batch-unit-'));
    const data=JSON.stringify([snapshot]);
    const input=JSON.stringify(buildRequest(snapshot))+'\n';
    fs.writeFileSync(path.join(output,'snapshot.json'),data);
    fs.writeFileSync(path.join(output,'input.jsonl'),input);
    fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify({jobId:'job_fixture',model:MODEL,version:VERSION,
        promptSha256:sha256(PROMPT),count:1,snapshotSha256:sha256(data),inputSha256:sha256(input)}));
    return output;
}
test('re-running submit does not create another paid batch',async t=>{
    const fs=require('node:fs');
    const {submit,loadPrepared}=require('../../scripts/reviewWebsiteImagesBatch.cjs');
    const output=preparedDirectory(),originalFetch=global.fetch,originalKey=process.env.OPENAI_API_KEY;
    t.after(()=>{global.fetch=originalFetch;if(originalKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=originalKey;fs.rmSync(output,{recursive:true});});
    process.env.OPENAI_API_KEY='offline-test';
    const calls=[];
    global.fetch=async(url,options)=>{
        calls.push({url,options});
        return Response.json(url.endsWith('/files')?{id:'file_fixture'}:{id:'batch_fixture',created_at:1,status:'validating'});
    };
    await submit(output);await submit(output);
    assert.equal(calls.length,2);assert.equal(calls[0].options.body.get('purpose'),'batch');
    const create=JSON.parse(calls[1].options.body);
    assert.equal(create.endpoint,'/v1/responses');assert.equal(create.completion_window,'24h');
    assert.equal(loadPrepared(output).manifest.batchId,'batch_fixture');
});
test('a lost submission response is recovered by job ID, without another POST',async t=>{
    const fs=require('node:fs');
    const {submit,loadPrepared}=require('../../scripts/reviewWebsiteImagesBatch.cjs');
    const output=preparedDirectory(),originalFetch=global.fetch,originalKey=process.env.OPENAI_API_KEY;
    t.after(()=>{global.fetch=originalFetch;if(originalKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=originalKey;fs.rmSync(output,{recursive:true});});
    process.env.OPENAI_API_KEY='offline-test';
    let postCount=0;
    global.fetch=async(url,options)=>{
        if(url.endsWith('/files'))return Response.json({id:'file_fixture'});
        if(options.method==='POST'){postCount++;throw new Error('lost_response');}
        return Response.json({has_more:false,data:[{id:'batch_recovered',created_at:1,status:'in_progress',metadata:{job_id:'job_fixture'}}]});
    };
    await assert.rejects(submit(output),/lost_response/);
    await submit(output);
    assert.equal(postCount,1);assert.equal(loadPrepared(output).manifest.batchId,'batch_recovered');
});
