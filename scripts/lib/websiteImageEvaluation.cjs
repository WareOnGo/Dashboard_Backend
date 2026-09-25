// Shadow evaluation only. Not imported by application routes or workers.
const { createHash } = require('node:crypto');
const VERSION = 'website-approval-eval-v1';
const POLICY_VERSION = 'website-gallery-policy-eval-v2';
const TIERS = ['T1', 'T2', 'T3', 'UNUSABLE'];
const { PROMPT, SCHEMA } = require('../../src/utils/websiteImagePolicy.cjs');

function stableSample(rows, n, seed) {
    return [...rows].sort((a,b) => createHash('sha256').update(`${seed}:${a.id}`).digest('hex')
        .localeCompare(createHash('sha256').update(`${seed}:${b.id}`).digest('hex'))).slice(0,n);
}
function chooseSample(inventory, seed = '2026-09-25') {
    const byUrl = new Map(inventory.images.map(row => [row.imageUrl,row]));
    const visible = inventory.warehouses.filter(row => row.visibility === true);
    const group = (a,b) => visible.filter(row => row.originalUrls.length >= a && row.originalUrls.length <= b);
    const cohort = [[1,3],[4,7],[8,12],[13,25]].flatMap(([a,b]) => stableSample(group(a,b),3,`${seed}:${a}-${b}`));
    const largest = [...visible].sort((a,b) => b.originalUrls.length-a.originalUrls.length)[0];
    const stress = largest && !cohort.some(w=>w.id===largest.id) ? [largest] : [];
    const picked = new Map();
    for (const w of [...cohort,...stress]) for (const url of w.originalUrls) {
        const row = byUrl.get(url);
        if (row) picked.set(row.id,{ ...row, warehouseIds:[w.id], sampleKind: stress.includes(w)?'large-gallery-stress':'gallery-cohort' });
    }
    const owners = new Map(visible.flatMap(w=>w.originalUrls.map(url=>[url,w.id])));
    const available = inventory.images.filter(row=>owners.has(row.imageUrl)&&!picked.has(row.id));
    const challenges = [
        [/\bto[ -]?let\b|for (?:rent|lease|sale)|rental sign/i,12],
        [/phone number|contact (?:number|detail)|watermark|mobile number/i,12],
        [/\bblur(?:ry|red)?\b|low.resolution|underexposed/i,8],
        [/signboard|signage|company sign/i,8],
    ];
    for (const [regex,n] of challenges) for (const row of stableSample(available.filter(row=>regex.test(row.description||'')&&!picked.has(row.id)),n,`${seed}:${regex}`)) {
        picked.set(row.id,{ ...row, warehouseIds:[owners.get(row.imageUrl)], sampleKind:'challenge' });
    }
    const rows = [...picked.values()];
    if (rows.length > 256) throw new Error('Sample exceeds the 256-image evaluation cap');
    return { version:VERSION,seed,cohortIds:cohort.map(w=>w.id),stressIds:stress.map(w=>w.id),images:rows,
        warehouses:[...cohort,...stress] };
}

// Provisional website-size guards, kept separate from the model's recorded opinion.
// A recognizable tiny photo may fill a sparse gallery but cannot become top-tier.
function effectiveAssessment(row) {
    if (!row.assessment) return null;
    const assessment={...row.assessment};
    const width=row.local?.width,height=row.local?.height;
    if (!(width>0&&height>0)) return assessment;
    const longest=Math.max(width,height);
    const ceiling=longest<640?'T3':longest<960?'T2':'T1';
    if (TIERS.indexOf(assessment.qualityTier)<TIERS.indexOf(ceiling)) assessment.qualityTier=ceiling;
    // Cards use a 16:9 crop at 640x360. This is a cover preference, not a safety gate.
    if (Math.min(width,height*16/9)<640) assessment.coverSuitable=false;
    return assessment;
}

// Privacy is a hard gate. Quality and balance can never bypass it. Exact duplicate
// identities/pixels can be suppressed; perceptual near-duplicates need review.
function selectGallery(rows, { minimum=4, maximum=8 }={}) {
    if (!Number.isInteger(minimum)||!Number.isInteger(maximum)||minimum<0||maximum<minimum) throw new Error('Invalid bounds');
    const seen=new Set();
    const candidates=rows.map(row=>({...row,modelQualityTier:row.assessment?.qualityTier,assessment:effectiveAssessment(row)})).filter(row=> {
        const a=row.assessment;
        return a && !row.error && a.decision==='ALLOW' && ['INDOOR','OUTDOOR'].includes(a.scene)
            && ['INDOOR','OUTDOOR'].includes(row.previousScene||a.scene)
            && ['T1','T2','T3'].includes(a.qualityTier) && !a.reasons?.length;
    }).map(row=>({...row,assessment:{...row.assessment,scene:row.previousScene||row.assessment.scene}}))
      .sort((a,b)=>TIERS.indexOf(a.assessment.qualityTier)-TIERS.indexOf(b.assessment.qualityTier)
        ||Number(b.assessment.coverSuitable)-Number(a.assessment.coverSuitable)||a.order-b.order)
      .filter(row=>{const key=row.duplicateGroup||row.originalUrl||row.id;if(seen.has(key))return false;seen.add(key);return true;});
    const picked=[];
    const pools=Object.fromEntries(['INDOOR','OUTDOOR'].map(scene=>[scene,candidates.filter(row=>row.assessment.scene===scene&&row.assessment.qualityTier!=='T3')]));
    const total=Math.min(maximum,pools.INDOOR.length+pools.OUTDOOR.length);
    const quota={INDOOR:Math.min(Math.ceil(total/2),pools.INDOOR.length),OUTDOOR:Math.min(Math.floor(total/2),pools.OUTDOOR.length)};
    let remaining=total-quota.INDOOR-quota.OUTDOOR;
    for(const scene of ['INDOOR','OUTDOOR']){const extra=Math.min(remaining,pools[scene].length-quota[scene]);quota[scene]+=extra;remaining-=extra;}
    function take(pool) {
        const views=new Set(picked.map(row=>row.assessment.view));
        pool.sort((a,b)=>TIERS.indexOf(a.assessment.qualityTier)-TIERS.indexOf(b.assessment.qualityTier)
            ||Number(views.has(a.assessment.view))-Number(views.has(b.assessment.view))
            ||Number(b.assessment.coverSuitable)-Number(a.assessment.coverSuitable)||a.order-b.order);
        picked.push(pool.shift());
    }
    while(picked.length<total)for(const scene of ['INDOOR','OUTDOOR'])if(quota[scene]>0){take(pools[scene]);quota[scene]--;}
    const fallback=candidates.filter(row=>row.assessment.qualityTier==='T3');
    while(fallback.length&&picked.length<minimum){
        const counts={INDOOR:0,OUTDOOR:0};for(const row of picked)counts[row.assessment.scene]++;
        // Within the same effective fallback tier prefer the clearer model-rated
        // photo before balance; a small clear image can beat a large blurry one.
        fallback.sort((a,b)=>TIERS.indexOf(a.modelQualityTier)-TIERS.indexOf(b.modelQualityTier)
            ||counts[a.assessment.scene]-counts[b.assessment.scene]||a.order-b.order);
        picked.push(fallback.shift());
    }
    // The first selected usable overall photo is the cover; order alternates
    // indoor/outdoor within the quality tier, retaining stable original ordering.
    const cover=[...picked].filter(row=>row.assessment.coverSuitable)
        .sort((a,b)=>TIERS.indexOf(a.assessment.qualityTier)-TIERS.indexOf(b.assessment.qualityTier)||a.order-b.order)[0]||picked[0];
    const ordered=cover?[cover,...picked.filter(row=>row!==cover)]:[];
    return { ids:ordered.map(row=>row.id), count:ordered.length, belowTarget:ordered.length<minimum,
        fallbackCount:ordered.filter(row=>row.assessment.qualityTier==='T3').length,
        indoor:ordered.filter(row=>row.assessment.scene==='INDOOR').length,
        outdoor:ordered.filter(row=>row.assessment.scene==='OUTDOOR').length };
}

module.exports={ VERSION,POLICY_VERSION,TIERS,PROMPT,SCHEMA,stableSample,chooseSample,effectiveAssessment,selectGallery };
