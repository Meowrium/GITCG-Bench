const fs = require('fs');
const { join } = require('path');

const TRAINING_PKGS = [
  'packages/typings', 'packages/utils', 'packages/config',
  'packages/core', 'packages/data', 'packages/assets-manager',
  'packages/custom-data-loader', 'packages/gi-agent', 'packages/gi-ml',
  'packages/llm-deck-analyzer',
];

// 1. Patch root workspaces
const root = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
root.workspaces = TRAINING_PKGS;
fs.writeFileSync('package.json', JSON.stringify(root, null, 2) + '\n');
console.log('Patched root workspaces to training-only');

// 2. Strip workspace deps pointing to non-existent packages
for (const ws of TRAINING_PKGS) {
  const pkgPath = join(ws, 'package.json');
  if (!fs.existsSync(pkgPath)) continue;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  let changed = false;
  for (const depKey of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[depKey];
    if (!deps) continue;
    for (const [name, version] of Object.entries(deps)) {
      if (typeof version === 'string' && version.startsWith('workspace:') &&
          !TRAINING_PKGS.some(p => name === '@gi-tcg/' + p.split('/').pop())) {
        delete deps[name];
        changed = true;
      }
    }
  }
  if (changed) {
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log('  Patched: ' + ws + '/package.json');
  }
}
console.log('Patch complete.');
