#!/bin/bash
# ==============================================================
#  Pack training pipeline into a single tarball for cloud deploy
# ==============================================================
# Usage: bash scripts/cloud-pack.sh
# Output: gi-training-cloud.tar.gz

set -euo pipefail
cd "$(dirname "$0")/.."

OUTPUT="gi-training-cloud.tar.gz"
rm -f "$OUTPUT"

echo "=== Packing → $OUTPUT ==="

# Collect only paths that exist, then tar
FILES=()

add() { for p in "$@"; do [ -e "$p" ] && FILES+=("$p"); done; }

# ── Training config & assets ──
add packages/gi-agent/benchmark.training-v3.json
add packages/gi-agent/plan-phases
add packages/gi-agent/.llm-deck-cache

# ── Scripts ──
add scripts/cloud-deploy.sh
add scripts/cloud-train.sh
add scripts/run-multi-iteration-training.ps1
add scripts/run-self-play-chunked.ts
add scripts/merge-rl-manifests.ts
add scripts/build.ts

# ── Core source packages (minimal — just what bun needs to build & run) ──
add packages/typings/src packages/typings/proto packages/typings/scripts packages/typings/package.json packages/typings/tsconfig.json packages/typings/buf.gen.yaml
add packages/utils/src   packages/utils/package.json   packages/utils/tsconfig.json
add packages/config/src  packages/config/package.json
add packages/core/src    packages/core/package.json    packages/core/tsconfig.json
add packages/data/src    packages/data/scripts packages/data/package.json    packages/data/tsconfig.json
add packages/assets-manager/src packages/assets-manager/scripts packages/assets-manager/package.json packages/assets-manager/tsconfig.json
add packages/custom-data-loader/src packages/custom-data-loader/package.json packages/custom-data-loader/tsconfig.json

# ── gi-agent (training runtime) ──
add packages/gi-agent/src packages/gi-agent/package.json packages/gi-agent/tsconfig.json

# ── gi-ml (model training — skip venvs, only source) ──
add packages/gi-ml/src packages/gi-ml/python/gitcg_ml packages/gi-ml/python/pyproject.toml packages/gi-ml/schemas packages/gi-ml/package.json packages/gi-ml/tsconfig.json

# ── llm-deck-analyzer (deck analysis) ──
add packages/llm-deck-analyzer/src packages/llm-deck-analyzer/package.json packages/llm-deck-analyzer/tsconfig.json

# ── Root config ──
add package.json bun.lock patches

echo "Packing ${#FILES[@]} paths..."

tar -czf "$OUTPUT" \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude '.lgbm-venv' \
  --exclude 'output' \
  --exclude 'dist' \
  --exclude '.tsbuildinfo' \
  --exclude '__tests__' \
  --exclude '*.test.ts' \
  --exclude '*.spec.ts' \
  --exclude '*.stackdump' \
  --exclude '.tmp' \
  --exclude '.claude' \
  --exclude '.opencode' \
  --exclude '*.db' \
  "${FILES[@]}"

SIZE=$(du -h "$OUTPUT" | cut -f1)
echo ""
echo "=== Done: $OUTPUT ($SIZE) ==="
echo ""
echo "Deploy:"
echo "  scp $OUTPUT root@SERVER:/opt/"
echo "  ssh root@SERVER 'cd /opt && tar -xzf gi-training-cloud.tar.gz && bash scripts/cloud-deploy.sh && bash scripts/cloud-train.sh'"
