const fs=require('node:fs/promises');
const path=require('node:path');
const sharp=require('sharp');
const {selectGallery,effectiveAssessment,VERSION,POLICY_VERSION}=require('./lib/websiteImageEvaluation.cjs');
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const counts=(rows,key)=>rows.reduce((out,row)=>{const value=key(row);out[value]=(out[value]||0)+1;return out;},{});
function distance(a,b){let bits=BigInt(`0x${a}`)^BigInt(`0x${b}`),n=0;while(bits){n++;bits&=bits-1n;}return n;}
async function report(sampleFile,directory,model='gpt-5.6-terra'){
    const sample=JSON.parse(await fs.readFile(sampleFile,'utf8'));
    const journal=path.join(directory,`${VERSION}-${model}.jsonl`);
    const complete=(await fs.readFile(journal,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    const byId=new Map(complete.map(row=>[row.id,row]));
    const results=sample.images.map(row=>byId.get(row.id)).filter(Boolean);
    const byUrl=new Map(results.map(row=>[row.originalUrl,row]));
    const near=[];
    const galleries=sample.warehouses.map(w=>{
        const rows=w.originalUrls.map((url,order)=>{const r=byUrl.get(url);return r?{...r,order,duplicateGroup:r.local?.sha256}:null;}).filter(Boolean);
        for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
            const a=rows[i].local,b=rows[j].local;if(!a?.dHash||!b?.dHash)continue;
            const difference=distance(a.dHash,b.dHash);
            if(difference<=6)near.push({warehouseId:w.id,a:rows[i].id,b:rows[j].id,distance:difference,exact:a.sha256===b.sha256});
        }
        return {id:w.id,cohort:sample.cohortIds.includes(w.id),original:w.originalUrls.length,evaluated:rows.length,
            decisions:counts(rows,r=>r.assessment?.decision||'ERROR'),
            quality:counts(rows,r=>r.assessment?.qualityTier||'ERROR'),
            effectiveQuality:counts(rows,r=>effectiveAssessment(r)?.qualityTier||'ERROR'),
            selections:Object.fromEntries([4,6,8].map(maximum=>[maximum,selectGallery(rows,{minimum:4,maximum})]))};
    });
    const summary={model,modelEvaluationVersion:VERSION,selectionPolicyVersion:POLICY_VERSION,total:results.length,expected:sample.images.length,
        decisions:counts(results,r=>r.assessment?.decision||'ERROR'),quality:counts(results,r=>r.assessment?.qualityTier||'ERROR'),
        effectiveQuality:counts(results,r=>effectiveAssessment(r)?.qualityTier||'ERROR'),
        dimensionDowngrades:results.filter(r=>r.assessment&&effectiveAssessment(r).qualityTier!==r.assessment.qualityTier)
            .map(r=>({id:r.id,warehouseIds:r.warehouseIds,width:r.local.width,height:r.local.height,
                modelTier:r.assessment.qualityTier,effectiveTier:effectiveAssessment(r).qualityTier})),
        sampleKinds:counts(results,r=>r.sampleKind||'ERROR'),galleries,nearDuplicates:near.sort((a,b)=>a.distance-b.distance),
        inputTokens:results.reduce((n,r)=>n+(r.inputTokens||0),0),outputTokens:results.reduce((n,r)=>n+(r.outputTokens||0),0)};
    await fs.writeFile(path.join(directory,'summary.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600});
    const tiles=results.filter(r=>r.local).map(r=>{
        const a=r.assessment||{},effective=effectiveAssessment(r)||{};return `<article data-decision="${escape(a.decision||'ERROR')}"><a href="images/${r.id}.original"><img loading="lazy" src="images/${r.id}.preview.jpg" alt="Image ${r.id}"></a><h3>${r.id} · WH ${escape(r.warehouseIds?.join(', '))}</h3><b>${escape(a.decision)} · ${escape(effective.qualityTier)} · ${escape(a.scene)} · ${escape(a.view)}</b><p>${r.local.width}×${r.local.height} · Model tier: ${escape(a.qualityTier)} · Cover preferred: ${Boolean(effective.coverSuitable)}</p><p>${escape(a.decisionReason)}</p><p>${escape(a.qualityReason)}</p><small>${escape(a.reasons?.join(', '))}</small></article>`;
    });
    const html=`<!doctype html><meta charset="utf-8"><title>Website image approval — local shadow evaluation</title><style>body{font:15px system-ui;margin:24px;background:#f5f6f8;color:#182337}header{position:sticky;top:0;background:white;padding:12px;z-index:1}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:16px}article{background:white;padding:12px;border:2px solid #98a4b7;border-radius:8px}article[data-decision=BLOCK]{border-color:#c94a4a}article[data-decision=REVIEW]{border-color:#d7992e}img{width:100%;height:240px;object-fit:contain}p{margin:8px 0;font-size:13px}button{margin:4px;padding:8px}small{color:#666}[hidden]{display:none!important}</style><header><h1>Website photo approval: shadow evaluation</h1><p>${results.length}/${sample.images.length} images · ${escape(model)} · model predictions, not verified truth. No live image selection has changed.</p><p>Click a photo for its original. Contact details are deliberately not transcribed.</p>${['ALL','ALLOW','BLOCK','REVIEW','ERROR'].map(x=>`<button data-filter="${x}">${x}</button>`).join('')}</header><main>${tiles.join('\n')}</main><script>document.querySelectorAll('button').forEach(button=>button.onclick=()=>document.querySelectorAll('article').forEach(card=>card.hidden=button.dataset.filter!=='ALL'&&button.dataset.filter!==card.dataset.decision));</script>`;
    await fs.writeFile(path.join(directory,'review.html'),html,{mode:0o600});
    // Blind contact sheets omit model decisions to make visual spot checks less anchored.
    const drawable=sample.images.filter(row=>byId.get(row.id)?.local);
    await fs.mkdir(path.join(directory,'sheets'),{recursive:true,mode:0o700});
    for(let start=0;start<drawable.length;start+=16){
        const page=drawable.slice(start,start+16);const parts=[];
        for(let i=0;i<page.length;i++){
            const row=page[i],x=(i%4)*400,y=Math.floor(i/4)*310;
            const photo=await sharp(path.join(directory,'images',`${row.id}.preview.jpg`)).resize(392,270,{fit:'contain',background:'#fff'}).toBuffer();
            parts.push({input:photo,left:x+4,top:y});
            const label=Buffer.from(`<svg width="400" height="40"><rect width="400" height="40" fill="#fff"/><text x="8" y="25" font-family="sans-serif" font-size="18">ID ${row.id} · WH ${row.warehouseIds.join(',')}</text></svg>`);
            parts.push({input:label,left:x,top:y+270});
        }
        await sharp({create:{width:1600,height:Math.ceil(page.length/4)*310,channels:3,background:'#ddd'}}).composite(parts).jpeg({quality:90})
            .toFile(path.join(directory,'sheets',`${String(start/16+1).padStart(2,'0')}.jpg`));
    }
    console.log(JSON.stringify({total:summary.total,expected:summary.expected,decisions:summary.decisions,quality:summary.quality,
        galleries:summary.galleries.map(g=>({id:g.id,before:g.original,evaluated:g.evaluated,after:g.selections[8]})),
        nearDuplicatePairs:near.length,report:path.join(directory,'review.html')},null,2));
    return summary;
}
module.exports={report,distance};
if(require.main===module){if(process.argv.length<4)throw new Error('Usage: reportWebsiteImageEval.cjs sample.json output-directory [model]');
    sharp.cache(false);sharp.concurrency(1);report(path.resolve(process.argv[2]),path.resolve(process.argv[3]),process.argv[4]).catch(e=>{console.error(e.message);process.exitCode=1;});}
