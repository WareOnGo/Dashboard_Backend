const { assessWebsiteImage, normalizeAssessment, validateAssessment, downloadOriginal, validateSource, MAX_BYTES } = require('../../src/utils/websiteImageAssessment.cjs');
const { PROMPT, SCHEMA } = require('../../src/utils/websiteImagePolicy.cjs');
const base = { decision:'ALLOW',reasons:[],scene:'INDOOR',qualityTier:'T1',qualityIssues:[],view:'INTERIOR_OVERVIEW',
    coverSuitable:true,decisionReason:'Property without contact details.',qualityReason:'Clear representative view.',confidence:.9,evidence:[] };
const source={sha256:'a'.repeat(64),width:1600,height:900,bytes:50000,format:'jpeg'};
const url='https://pub-00000000000000000000000000000000.r2.dev/test.jpg';

test('runtime and benchmark use the identical prompt and schema',()=>{
    const evaluation=require('../../scripts/lib/websiteImageEvaluation.cjs');
    expect(evaluation.PROMPT).toBe(PROMPT);expect(evaluation.SCHEMA).toEqual(SCHEMA);
});
test('size guards retain the original model opinion but demote a tiny source',()=>{
    const r=normalizeAssessment(base,{...source,width:319,height:196});
    expect(r).toMatchObject({decision:'ALLOW',qualityTier:'T3',assessment:{modelQualityTier:'T1',coverSuitable:false,sourceSha256:source.sha256}});
    expect(base.qualityTier).toBe('T1');
});
test('benchmark dark detail and obstructed blur failures are fallback-only',()=>{
    for(const extra of [{view:'DETAIL',qualityIssues:['DARK','TIGHT_CROP']},
        {view:'WASHROOM',qualityIssues:['DARK','BLUR','OBSTRUCTION']}]){
        expect(normalizeAssessment({...base,qualityTier:'T2',...extra},source).qualityTier).toBe('T3');
    }
    expect(normalizeAssessment({...base,qualityTier:'T2',qualityIssues:['DARK']},source).qualityTier).toBe('T2');
});
test('contact decisions never become allowed or preferred covers',()=>{
    for(const decision of ['BLOCK','REVIEW'])expect(normalizeAssessment({...base,decision,reasons:['CONTACT_NUMBER']},source))
        .toMatchObject({decision,assessment:{coverSuitable:false}});
});
test('inconsistent allows cannot publish a document or suspected contact',()=>{
    expect(normalizeAssessment({...base,scene:'DOCUMENT'},source).decision).toBe('BLOCK');
    expect(normalizeAssessment({...base,reasons:['CONTACT_NUMBER']},source).decision).toBe('REVIEW');
});
test('valid quality cannot make washrooms or undersized crops preferred covers',()=>{
    expect(normalizeAssessment({...base,view:'WASHROOM'},source).assessment.coverSuitable).toBe(false);
    expect(normalizeAssessment(base,{...source,width:500,height:1200}).assessment.coverSuitable).toBe(false);
});
test('invalid results and invalid evidence fail instead of granting approval',()=>{
    for(const r of [{...base,qualityTier:'UNKNOWN'},{...base,confidence:2},{...base,reasons:null},
        {...base,evidence:[{x1:500,x2:400,y1:0,y2:10,note:'bad'}]},{}])expect(()=>validateAssessment(r)).toThrow();
});
test('accidentally transcribed contacts are removed from assessment text',()=>{
    const r=normalizeAssessment({...base,decisionReason:'Call +91 90000 00000 or fixture@example.test'},source);
    expect(r.assessment.decisionReason).not.toContain('90000');expect(r.assessment.decisionReason).not.toContain('@');
});
test('image downloads restrict destinations and reject redirects through fetch settings',async()=>{
    for(const value of ['http://127.0.0.1/x.jpg','https://example.test/x.jpg','https://user:pass@pub-00000000000000000000000000000000.r2.dev/a.jpg']){
        expect(()=>validateSource(value)).toThrow();
    }
    const http=jest.fn(async()=>new Response(Buffer.from('source')));
    expect((await downloadOriginal(url,undefined,http)).buffer.toString()).toBe('source');
    expect(http).toHaveBeenCalledWith(url,expect.objectContaining({redirect:'error'}));
});
test('oversized downloads and missing objects produce explicit errors',async()=>{
    const large=async()=>new Response('x',{headers:{'content-length':String(MAX_BYTES+1)}});
    await expect(downloadOriginal(url,undefined,large)).rejects.toMatchObject({code:'source_over_20MiB',unsupported:true});
    await expect(downloadOriginal(url,undefined,async()=>new Response('',{status:404}))).rejects.toMatchObject({code:'source_http_404'});
});
test('the worker sends the checked original bytes and records their identity',async()=>{
    const sharp=require('sharp');const {createHash}=require('crypto');
    const bytes=await sharp({create:{width:1000,height:600,channels:3,background:'#999'}}).jpeg().toBuffer();
    const modelCall=jest.fn(async()=>({...base,inputTokens:50,outputTokens:10}));
    const result=await assessWebsiteImage(url,{http:async()=>new Response(bytes,{headers:{etag:'fixture-etag'}}),modelCall});
    expect(result.assessment).toMatchObject({sourceSha256:createHash('sha256').update(bytes).digest('hex'),
        sourceWidth:1000,sourceHeight:600,sourceBytes:bytes.length,sourceFormat:'jpeg',sourceEtag:'fixture-etag'});
    expect(modelCall).toHaveBeenCalledWith('gpt-5.6-luna',`data:image/jpeg;base64,${bytes.toString('base64')}`,PROMPT,SCHEMA,
        expect.objectContaining({detail:'high',maxAttempts:2,signal:expect.any(AbortSignal)}));
});
test('source network failures use a stable error code and never call the model',async()=>{
    const modelCall=jest.fn();
    await expect(assessWebsiteImage(url,{http:async()=>{throw new TypeError('fetch failed');},modelCall}))
        .rejects.toMatchObject({code:'source_download_failed'});
    expect(modelCall).not.toHaveBeenCalled();
});
