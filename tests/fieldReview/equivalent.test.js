const {equivalent}=require('../../src/fieldReview/equivalent');
test.each([
 ['32','32.0 feet','clearHeightFt'],
 ['24,000 ft','24000 feet','dockApronLengthFt'],
 ['25','25.00','ratePerSqft'],
 ['0091 99999 99999','+919999999999','contactNumber'],
 [['FMCG','PHARMA'],['PHARMA','FMCG'],'suitableFor'],
 [null,'','ownerAltPoc'],
])('formatting-only differences compare equal: %s and %s', (a,b,key)=>expect(equivalent(a,b,key)).toBe(true));
test.each([
 [null,0,'chargeableArea'],
 ['32 feet','32 metres','clearHeightFt'],
 ['50','50 sq ft','builtup_area'],
 [[25000,23000],[23000,25000],'totalSpaceSqft'],
 ['12,5','125','ratePerSqft'],
 ['24.5','25','ratePerSqft'],
])('preserves meaning, floor order and missing versus zero: %s and %s',(a,b,key)=>expect(equivalent(a,b,key)).toBe(false));
