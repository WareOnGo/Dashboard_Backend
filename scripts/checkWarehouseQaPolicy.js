const fs = require('node:fs');
const { hash } = require('../src/warehouseQa/common');
const bundled = Object.values(require('../src/warehouseQa/policy').policy);

function check(markdown) {
  const records = [...markdown.matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
    .map((match) => JSON.parse(match[1]))
    .filter((record) => record.record_type && record.id);
  if (new Set(records.map((record) => record.id)).size !== records.length)
    throw new Error('Duplicate SOP record IDs.');
  const indexed = (list) => Object.fromEntries(list.map((record) => [record.id, record]));
  if (hash(indexed(records)) !== hash(indexed(bundled)))
    throw new Error(
      'Bundled QA policy differs from the Markdown SOP. Export and review the new policy before changing the engine profile.'
    );
  return { matched: true, records: records.length, policy_version: indexed(records).WAREHOUSE_QA.version };
}
module.exports = { check };
if (require.main === module) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/checkWarehouseQaPolicy.js <SOP.md>');
  console.log(JSON.stringify(check(fs.readFileSync(process.argv[2], 'utf8'))));
}
