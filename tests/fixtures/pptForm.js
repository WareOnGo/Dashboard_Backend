const completePptForm = () => ({
    listing_type: 'Rent', warehouseType: 'PEB', address: 'QA locality', city: 'New Delhi', state: 'Delhi',
    contactPerson: 'QA Owner', contactNumber: '9876543210', uploadedBy: 'QA1234', compliances: 'CLU checked',
    googleLocation: 'https://www.google.com/maps?q=12,77', totalSpaceSqft: [10000], ratePerSqft: '25',
    clearHeightFt: '30 feet', flooringType: 'VDF', floorStrengthPerSqm: '5 tonnes/sq m', numberOfDocks: '0',
    plinthHeightFt: '0 feet', canopyType: 'None', ventilationType: 'None', washroom_count: 'Male: 0; Female: 0',
    handoverType: 'FIXED', handoverDate: '2027-02-28', handoverLeadValue: null, handoverLeadUnit: null,
    warehouseData: { landType: 'Warehouse CLU', powerKva: 'As per requirement', fireNocAvailable: false, fireSafetyMeasures: 'None' },
});
const requiredPaths = ['warehouseType', 'address', 'googleLocation', 'warehouseData.landType', 'totalSpaceSqft', 'ratePerSqft',
    'clearHeightFt', 'flooringType', 'floorStrengthPerSqm', 'numberOfDocks', 'plinthHeightFt', 'canopyType', 'ventilationType',
    'washroom_count', 'warehouseData.powerKva', 'warehouseData.fireNocAvailable', 'warehouseData.fireSafetyMeasures'];
const patchForPath = (path, value) => path.startsWith('warehouseData.') ? { warehouseData: { [path.split('.')[1]]: value } } : { [path]: value };
module.exports = { completePptForm, requiredPaths, patchForPath };
