// Local benchmark report. Reads frozen model results; never calls APIs or writes DB/R2.
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {PROMPT,SCHEMA,VERSION,POLICY_VERSION,effectiveAssessment,selectGallery}=require('./lib/websiteImageEvaluation.cjs');
const counts=(rows,key)=>rows.reduce((out,row)=>{const value=key(row);out[value]=(out[value]||0)+1;return out;},{});
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sha=value=>createHash('sha256').update(value).digest('hex');
function distribution(values){
    const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
    const at=q=>sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*q))]??null;
    return {n:sorted.length,mean:sorted.length?sorted.reduce((a,b)=>a+b,0)/sorted.length:null,median:at(.5),p95:at(.95)};
}
const eligible=row=>selectGallery([{...row,order:0}]).count===1;
function checkedResults(report,sample){
    if(report.version!==VERSION||report.results.length!==sample.images.length)throw new Error('Incomplete or incompatible model run');
    const byId=new Map(report.results.map(r=>[r.id,r]));
    if(byId.size!==sample.images.length||sample.images.some(r=>!byId.has(r.id)))throw new Error('Mismatched image IDs');
    return byId;
}
function referenceMetrics(byId,reference){
    const blocked=reference.rows.filter(r=>r.expected==='BLOCK'),safe=reference.rows.filter(r=>r.expected==='ALLOW');
    return {
        knownBlocked:blocked.length,
        unsafeAllowIds:blocked.filter(r=>byId.get(r.id)?.assessment?.decision==='ALLOW').map(r=>r.id),
        unsafeEligibleIds:blocked.filter(r=>eligible(byId.get(r.id))).map(r=>r.id),
        blockedDecisions:counts(blocked,r=>byId.get(r.id)?.assessment?.decision||'ERROR'),
        apparentlySafe:safe.length,
        falseBlockIds:safe.filter(r=>byId.get(r.id)?.assessment?.decision==='BLOCK').map(r=>r.id),
        safeReviewIds:safe.filter(r=>byId.get(r.id)?.assessment?.decision==='REVIEW').map(r=>r.id),
        safeDecisions:counts(safe,r=>byId.get(r.id)?.assessment?.decision||'ERROR'),
        unresolved:reference.rows.filter(r=>r.expected==='UNRESOLVED').map(r=>({id:r.id,decision:byId.get(r.id)?.assessment?.decision||'ERROR'})),
    };
}
async function compare(root){
    const read=async file=>JSON.parse(await fs.readFile(path.join(root,file),'utf8'));
    const [sample,manifest,reference]=await Promise.all([read('sample.json'),read('manifest.json'),read('reference.json')]);
    const visualReview=await read('visual-review.json').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(manifest.promptSha256!==sha(PROMPT)||manifest.schemaSha256!==sha(JSON.stringify(SCHEMA))
        ||manifest.version!==VERSION||manifest.policyVersion!==POLICY_VERSION)throw new Error('Benchmark prompt/schema/policy changed');
    if(manifest.sampleSha256!==sha(await fs.readFile(path.join(root,'sample.json'))))throw new Error('Sample changed');
    const reports=await Promise.all(manifest.models.map(model=>read(`${model}/results-${model}.json`)));
    const maps=reports.map(r=>checkedResults(r,sample));
    for(const item of sample.images){
        const rows=maps.map(map=>map.get(item.id));
        if(rows.some(r=>r.error||!r.assessment||!r.local?.sha256))throw new Error(`Unfinished/error result ${item.id}; complete/retry before comparison`);
        if(new Set(rows.map(r=>r.local.sha256)).size!==1)throw new Error(`Different input pixels for ${item.id}`);
        if(rows.some(r=>r.inputTransport!=='original-bytes'||r.version!==VERSION))throw new Error('Different input transport/version');
    }
    for(const r of reference.rows)if(maps[0].get(r.id)?.local.sha256!==r.sha256)throw new Error('Reference source changed');
    const metrics=Object.fromEntries(reports.map((report,i)=>[report.model,{
        images:report.results.length,
        decisions:counts(report.results,r=>r.assessment.decision),
        quality:counts(report.results,r=>r.assessment.qualityTier),
        effectiveQuality:counts(report.results,r=>effectiveAssessment(r).qualityTier),
        eligible:report.results.filter(eligible).length,
        latencyMs:distribution(report.results.map(r=>r.latencyMs)),
        inputTokens:report.results.reduce((n,r)=>n+r.inputTokens,0),
        outputTokens:report.results.reduce((n,r)=>n+r.outputTokens,0),
        cohorts:Object.fromEntries([...new Set(report.results.map(r=>r.sampleKind))].map(kind=>[kind,{
            images:report.results.filter(r=>r.sampleKind===kind).length,
            decisions:counts(report.results.filter(r=>r.sampleKind===kind),r=>r.assessment.decision),
        }])),
        reference:referenceMetrics(maps[i],reference),
    }]));
    const pairs=sample.images.map(item=>{
        const [a,b]=maps.map(map=>map.get(item.id)),ae=effectiveAssessment(a),be=effectiveAssessment(b);
        return {id:item.id,warehouseIds:item.warehouseIds,sampleKind:item.sampleKind,
            decisionDifferent:a.assessment.decision!==b.assessment.decision,
            allowBoundaryDifferent:(a.assessment.decision==='ALLOW')!==(b.assessment.decision==='ALLOW'),
            qualityDifferent:a.assessment.qualityTier!==b.assessment.qualityTier,
            effectiveQualityDifferent:ae.qualityTier!==be.qualityTier,
            eligibilityDifferent:eligible(a)!==eligible(b),
            models:Object.fromEntries([a,b].map(r=>[r.model,{...r.assessment,effectiveTier:effectiveAssessment(r).qualityTier,eligible:eligible(r)}])),
        };
    });
    const galleries=sample.warehouses.map(w=>{
        const selections=Object.fromEntries(reports.map((r,i)=>{
            const byUrl=new Map([...maps[i].values()].map(row=>[row.originalUrl,row]));
            const rows=w.originalUrls.map((url,order)=>{const row=byUrl.get(url);if(!row)throw new Error('Missing gallery member');return {...row,order,duplicateGroup:row.local.sha256};});
            return [r.model,selectGallery(rows)];
        }));
        const [a,b]=Object.values(selections);
        return {warehouseId:w.id,before:w.originalUrls.length,cohort:sample.cohortIds.includes(w.id),selections,
            coverDifferent:a.ids[0]!==b.ids[0],membershipDifferent:[...a.ids].sort().join(',')!==[...b.ids].sort().join(','),
            orderDifferent:a.ids.join(',')!==b.ids.join(',')};
    });
    const bothAllowed=pairs.filter(p=>manifest.models.every(m=>p.models[m].decision==='ALLOW'));
    const report={at:new Date().toISOString(),manifest,referenceScope:reference.scope,metrics,
        bothAllowedQuality:{images:bothAllowed.length,agreements:bothAllowed.filter(p=>!p.effectiveQualityDifferent).length,
            tiers:Object.fromEntries(manifest.models.map(m=>[m,counts(bothAllowed,p=>p.models[m].effectiveTier)]))},
        agreements:{total:pairs.length,decision:pairs.filter(p=>!p.decisionDifferent).length,
            allowBoundary:pairs.filter(p=>!p.allowBoundaryDifferent).length,
            quality:pairs.filter(p=>!p.qualityDifferent).length,effectiveQuality:pairs.filter(p=>!p.effectiveQualityDifferent).length},
        decisionMatrix:counts(pairs,p=>manifest.models.map(m=>p.models[m].decision).join(' / ')),
        pairs,galleries,visualReview,
    };
    await fs.writeFile(path.join(root,'comparison.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
    const cell=(p,model)=>{const r=p.models[model];return `<div><strong>${escape(model)}: ${escape(r.decision)} · ${escape(r.qualityTier)} → ${escape(r.effectiveTier)}</strong><p>${escape(r.decisionReason)}</p><p>${escape(r.qualityReason)}</p><small>${escape(r.reasons.join(', '))} · cover: ${r.coverSuitable} · ${escape(r.view)}</small></div>`;};
    const reviewed=new Map((visualReview?.rows||[]).map(row=>[row.id,row]));
    const cards=pairs.map(p=>`<article data-decision="${p.decisionDifferent}" data-boundary="${p.allowBoundaryDifferent}" data-quality="${p.qualityDifferent}"><h3>Image ${p.id} · WH ${p.warehouseIds.join(', ')}</h3><a href="${manifest.models[0]}/images/${p.id}.original"><img loading="lazy" src="${manifest.models[0]}/images/${p.id}.preview.jpg" alt="Image ${p.id}"></a><section>${manifest.models.map(m=>cell(p,m)).join('')}</section>${reviewed.has(p.id)?`<p><b>Assistant review after comparison:</b> ${escape(reviewed.get(p.id).note)}</p>`:''}</article>`);
    const rows=manifest.models.map(m=>{const r=metrics[m];return `<tr><th>${escape(m)}</th><td>${r.decisions.ALLOW||0}</td><td>${r.decisions.BLOCK||0}</td><td>${r.decisions.REVIEW||0}</td><td>${(r.latencyMs.median/1000).toFixed(2)}s</td><td>${r.reference.unsafeAllowIds.length}/${r.reference.knownBlocked}</td></tr>`;});
    const html=`<!doctype html><meta charset="utf-8"><title>Luna / Terra website image benchmark</title><style>body{font:15px system-ui;margin:24px;color:#172638;background:#f5f6f8}header{background:white;padding:16px}table{border-collapse:collapse}td,th{padding:10px;border:1px solid #ccc}nav{position:sticky;top:0;background:white;padding:10px}button{margin-right:8px;padding:8px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(550px,1fr));gap:16px}article{background:white;padding:16px;border:1px solid #ccc;border-radius:8px}article[data-boundary=true]{border:3px solid #d28c27}img{width:100%;height:300px;object-fit:contain}section{display:grid;grid-template-columns:1fr 1fr;gap:18px}p{line-height:1.4}small{color:#586174}[hidden]{display:none!important}@media(max-width:650px){main{display:block}section{grid-template-columns:1fr}}</style><header><h1>Same 202 originals: Luna vs Terra</h1><p>Identical prompt/schema, high detail, original bytes. No live changes. Agreement is not accuracy. Reference checks are a small assistant-reviewed sanity set, not independent expert ground truth.</p><table><tr><th>Model</th><th>Allow</th><th>Block</th><th>Review</th><th>Median request</th><th>Known-blocked → allow</th></tr>${rows.join('')}</table><p>Click a photo for its original. Contact text is not transcribed. Times measure successful API requests, not full worker wall time.</p></header><nav><button data-filter="all">All</button><button data-filter="boundary">Allow/withhold disagreements</button><button data-filter="decision">All decision disagreements</button><button data-filter="quality">Quality disagreements</button></nav><main>${cards.join('\n')}</main><script>document.querySelectorAll('button').forEach(button=>button.onclick=()=>document.querySelectorAll('article').forEach(card=>card.hidden=button.dataset.filter!=='all'&&card.dataset[button.dataset.filter]!=='true'));</script>`;
    const observedMisses=(visualReview?.rows||[]).filter(row=>row.unsafeAllowModels?.length);
    const reviewWarning=observedMisses.length?`<p><b>Additional finding after comparing disagreements:</b> ${observedMisses.map(row=>`Image ${row.id}: confirmed contact details were allowed by ${escape(row.unsafeAllowModels.join(', '))}.`).join(' ')} The small reference check below does not include these later discoveries.</p>`:'';
    await fs.writeFile(path.join(root,'comparison.html'),html.replace('<table>',reviewWarning+'<table>'),{mode:0o600});
    console.log(JSON.stringify({metrics,agreements:report.agreements,decisionMatrix:report.decisionMatrix,
        disagreements:pairs.filter(p=>p.decisionDifferent).map(p=>({id:p.id,warehouseIds:p.warehouseIds,models:Object.fromEntries(manifest.models.map(m=>[m,{decision:p.models[m].decision,reason:p.models[m].decisionReason}]))})),
        galleryCounts:galleries.map(g=>({warehouseId:g.warehouseId,coverDifferent:g.coverDifferent,counts:Object.fromEntries(manifest.models.map(m=>[m,g.selections[m].count]))})),report:path.join(root,'comparison.html')},null,2));
    return report;
}
module.exports={compare,distribution,referenceMetrics};
if(require.main===module){if(process.argv.length!==3)throw new Error('Usage: compareWebsiteImageModels.cjs benchmark-directory');
    compare(path.resolve(process.argv[2])).catch(error=>{console.error(error.message);process.exitCode=1;});}
