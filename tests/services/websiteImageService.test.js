jest.mock('../../src/utils/imageCacheInvalidation',()=>({invalidateImageCache:jest.fn(async()=>{})}));
const Service=require('../../src/services/websiteImageService');
const {AssessmentError}=require('../../src/utils/websiteImageAssessment.cjs');
const result={decision:'ALLOW',qualityTier:'T2',assessment:{},usage:{inputTokens:10,outputTokens:2}};
function fixture(rows=[{id:1,imageUrl:'fixture',websiteClaimToken:'token'}]){
    const queue=[...rows];const repository={claim:jest.fn(async()=>{const row=queue.shift();return row?[row]:[];}),
        complete:jest.fn(async()=>1),fail:jest.fn(async()=>1),backlog:jest.fn(async()=>({PENDING:1}))};
    const log={tryStart:jest.fn(async()=>({id:1n})),finish:jest.fn(async()=>{})};
    const assess=jest.fn(async()=>result);return{repository,log,assess,service:new Service(repository,log,{assess})};
}
test('website assessment writes only the independent website stage',async()=>{
    const {repository,assess,service}=fixture();const out=await service.processBatch({limit:1});
    expect(out).toMatchObject({assessed:1,failed:0,decisions:{ALLOW:1}});
    expect(repository.complete).toHaveBeenCalledWith('website',expect.any(Object),result);
    expect(repository.claim).toHaveBeenCalledWith('website',{limit:1,allEntries:false});expect(assess).toHaveBeenCalledTimes(1);
});
test('all-entry backfill includes retained rows without changing other stages',async()=>{
    const {repository,service}=fixture();await service.processBatch({limit:1,allEntries:true});
    expect(repository.claim).toHaveBeenCalledWith('website',{limit:1,allEntries:true});
});
test('missing/corrupt source is recorded separately and does not approve it',async()=>{
    const {repository,assess,service}=fixture();assess.mockRejectedValue(new AssessmentError('source_http_404',true));
    expect(await service.processBatch({limit:1})).toMatchObject({assessed:0,failed:1,unsupported:1});
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledWith('website',expect.any(Object),'source_http_404',{deferred:false,unsupported:true});
});
test('an expired/stolen lease does not count as successful publication',async()=>{
    const {repository,service}=fixture();repository.complete.mockResolvedValue(0);
    expect(await service.processBatch({limit:1})).toMatchObject({assessed:0,stale:1,decisions:{ALLOW:0}});
});
test('cancellation after starting work counts an attempt and stops new claims',async()=>{
    const {repository,assess,service}=fixture([{id:1,imageUrl:'a'},{id:2,imageUrl:'b'}]);const controller=new AbortController();
    assess.mockImplementation(async()=>{controller.abort();throw new Error('aborted');});
    expect(await service.processBatch({limit:2,concurrency:1,signal:controller.signal})).toMatchObject({processed:1,failed:1});
    expect(repository.claim).toHaveBeenCalledTimes(1);expect(repository.fail.mock.calls[0][3].deferred).toBe(false);
});
test('dry run and overlapping sweeps perform no paid work',async()=>{
    const {log,assess,service}=fixture();await service.sweep({dryRun:true});expect(log.tryStart).not.toHaveBeenCalled();
    const previous=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-only';
    try{log.tryStart.mockResolvedValue(null);expect((await service.sweep()).status).toBe('SKIPPED');expect(assess).not.toHaveBeenCalled();}
    finally{if(previous===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous;}
});
test('rolling workers respect the explicit memory/network concurrency bound',async()=>{
    const {assess,service}=fixture(Array.from({length:10},(_,id)=>({id,imageUrl:'fixture'})));let active=0,peak=0;
    assess.mockImplementation(async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;return result;});
    expect((await service.processBatch({limit:10,concurrency:3})).assessed).toBe(10);expect(peak).toBe(3);
});
test('fatal model configuration aborts sibling work and waits for cleanup',async()=>{
    const {assess,service,repository}=fixture([{id:1,imageUrl:'a'},{id:2,imageUrl:'b'},{id:3,imageUrl:'c'}]);
    assess.mockImplementation(async(url,{signal})=>{
        if(url==='a')throw new AssessmentError('model_http_401');
        await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));throw new Error('cancelled');
    });
    await expect(service.processBatch({limit:3,concurrency:2})).rejects.toThrow('configuration rejected');
    expect(repository.claim).toHaveBeenCalledTimes(2);expect(repository.fail).toHaveBeenCalledTimes(2);
});
test('a transient publication timeout retries the saved assessment without another model call',async()=>{
    const {repository,assess,service}=fixture();
    repository.complete.mockRejectedValueOnce(Object.assign(new Error('pool timeout'),{code:'P2024'}));
    expect(await service.processBatch({limit:1})).toMatchObject({assessed:1,failed:0});
    expect(assess).toHaveBeenCalledTimes(1);expect(repository.complete).toHaveBeenCalledTimes(2);
});
test('permanent database errors stop work without retrying or resubmitting the image',async()=>{
    const {repository,assess,service}=fixture();
    repository.complete.mockRejectedValue(Object.assign(new Error('constraint violation'),{code:'P2010',meta:{code:'23514'}}));
    await expect(service.processBatch({limit:1})).rejects.toThrow('constraint violation');
    expect(assess).toHaveBeenCalledTimes(1);expect(repository.complete).toHaveBeenCalledTimes(1);
});
