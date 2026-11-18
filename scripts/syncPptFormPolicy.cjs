#!/usr/bin/env node
// Run from the backend checkout. This release check requires both client checkouts.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/utils/pptFormPolicy.js'), 'utf8');
const expected = source.replace(/^module\.exports = (.+);$/m, 'export $1;');
if (expected === source) throw new Error('Canonical policy export was not found.');
const write = process.argv.includes('--write');
const failures = [];
for (const name of ['Frontend_Repository', 'Scout_Frontend']) {
    const target = path.resolve(root, '..', name, 'src/utils/pptFormPolicy.js');
    if (write) fs.writeFileSync(target, expected);
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== expected) failures.push(name);
}
if (failures.length) {
    console.error(`PPT policy copies missing or different: ${failures.join(', ')}. Check out both clients beside the backend and run this script with --write.`);
    process.exitCode = 1;
} else console.log(`PPT policy parity verified for backend, dashboard and Scout${write ? ' (client copies regenerated)' : ''}.`);
