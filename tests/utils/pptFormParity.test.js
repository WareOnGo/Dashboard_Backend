const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

test('the release gate generates identical copies and fails if either client drifts or is absent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-policy-parity-'));
    try {
        for (const repo of ['Backend_Repository', 'Frontend_Repository', 'Scout_Frontend']) fs.mkdirSync(path.join(root, repo, 'src/utils'), { recursive: true });
        const script = path.join(root, 'Backend_Repository/scripts/syncPptFormPolicy.cjs');
        fs.mkdirSync(path.dirname(script));
        fs.copyFileSync(path.join(__dirname, '../../scripts/syncPptFormPolicy.cjs'), script);
        fs.copyFileSync(path.join(__dirname, '../../src/utils/pptFormPolicy.js'), path.join(root, 'Backend_Repository/src/utils/pptFormPolicy.js'));
        expect(spawnSync(process.execPath, [script, '--check']).status).toBe(1);
        execFileSync(process.execPath, [script, '--write']);
        expect(spawnSync(process.execPath, [script, '--check']).status).toBe(0);
        fs.appendFileSync(path.join(root, 'Scout_Frontend/src/utils/pptFormPolicy.js'), '\n// Drift\n');
        expect(spawnSync(process.execPath, [script, '--check']).status).toBe(1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
