#!/bin/bash
# ==============================================================
#  Cloud Training Deployment — Genius Invokation TCG AL Pipeline
# ==============================================================
#
# Usage (from local machine):
#   1. Push code:   git push
#   2. Upload assets:
#        scp -r packages/gi-agent/plan-phases/           root@SERVER:/opt/gi-training/packages/gi-agent/
#        scp -r packages/gi-agent/.llm-deck-cache/       root@SERVER:/opt/gi-training/packages/gi-agent/
#        scp    packages/gi-agent/benchmark.training-v3.json root@SERVER:/opt/gi-training/packages/gi-agent/
#   3. On server:
#        ssh root@SERVER
#        cd /opt/gi-training
#        bash scripts/cloud-deploy.sh
#        bash scripts/cloud-train.sh
#
# Requirements: Ubuntu 22.04+, root access

set -euo pipefail

export PATH="$HOME/.bun/bin:$PATH"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "=== Installing system dependencies ==="
apt-get update -qq
apt-get install -y -qq curl unzip git build-essential python3 python3-venv python3-pip cmake 2>&1 | tail -5

# ── Install Bun ──
if ! command -v bun &>/dev/null; then
  echo "=== Installing Bun ==="
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  # Add to profile for persistence
  echo 'export BUN_INSTALL="$HOME/.bun"' >> ~/.bashrc
  echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> ~/.bashrc
fi

# ── Patch package.json files to remove non-training dependencies ──
echo "=== Patching workspace and dependency declarations ==="

~/.bun/bin/bun -e "
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

// 1. Root: only include training-essential workspaces
const root = JSON.parse(readFileSync('./package.json', 'utf-8'));
const TRAINING_PKGS = [
  'packages/typings',
  'packages/utils',
  'packages/config',
  'packages/core',
  'packages/data',
  'packages/assets-manager',
  'packages/custom-data-loader',
  'packages/gi-agent',
  'packages/gi-ml',
  'packages/llm-deck-analyzer',
];
root.workspaces = TRAINING_PKGS;
writeFileSync('./package.json', JSON.stringify(root, null, 2) + '\n');

// 2. Strip workspace deps pointing to non-existent packages from ALL packages
for (const ws of TRAINING_PKGS) {
  const pkgPath = join(ws, 'package.json');
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  let changed = false;
  for (const depKey of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[depKey];
    if (!deps) continue;
    for (const [name, version] of Object.entries(deps)) {
      if (typeof version === 'string' && version.startsWith('workspace:') && !TRAINING_PKGS.some(p => name === '@gi-tcg/' + p.split('/').pop())) {
        delete deps[name];
        changed = true;
      }
    }
  }
  if (changed) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log('  Patched: ' + ws + '/package.json');
  }
}

console.log('Patch complete.');
"

# ── Install JS dependencies (including patched packages) ──
echo "=== Installing Node.js dependencies ==="
bun install

# Remove bun npm package shims — on Linux the globally installed bun is used.
# The npm "bun" package ships Windows .exe files that can't run here.
rm -f node_modules/.bin/bun node_modules/.bin/bunx node_modules/bun 2>/dev/null || true

# ── Build typings (needed by core; proto files already generated in src/gen/) ──
echo "=== Skipping build:buf — proto files already committed ==="

# ── Set up Python LightGBM venv ──
echo "=== Setting up Python venv for LightGBM ==="
PYTHON_VENV="$REPO_ROOT/packages/gi-ml/python/.lgbm-venv"
if [ ! -d "$PYTHON_VENV" ]; then
  python3 -m venv "$PYTHON_VENV"
fi
source "$PYTHON_VENV/bin/activate"
pip install -q lightgbm numpy
deactivate

# Also set up main Python venv for gi-ml dependencies
PYTHON_MAIN_VENV="$REPO_ROOT/packages/gi-ml/python/.venv"
if [ ! -d "$PYTHON_MAIN_VENV" ]; then
  python3 -m venv "$PYTHON_MAIN_VENV"
fi
source "$PYTHON_MAIN_VENV/bin/activate"
pip install -q -r "$REPO_ROOT/packages/gi-ml/python/pyproject.toml" 2>/dev/null || true
pip install -q torch --index-url https://download.pytorch.org/whl/cpu 2>/dev/null || true
deactivate

# ── Verify ──
echo ""
echo "=== Deployment complete ==="
echo "Bun:  $(bun --version)"
echo "Python: $(python3 --version)"
echo "LightGBM venv: $PYTHON_VENV"
echo ""
echo "Next: bash scripts/cloud-train.sh"
