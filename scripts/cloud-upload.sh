#!/bin/bash
# ==============================================================
#  Upload training assets to cloud server
# ==============================================================
# Usage: bash scripts/cloud-upload.sh root@your-server-ip
#
# Uploads: plan-phases, LLM cache, benchmark, and the full repo.
# Run this from the repo root BEFORE logging into the server.

set -euo pipefail

SERVER="${1:-}"
if [ -z "$SERVER" ]; then
  echo "Usage: bash scripts/cloud-upload.sh root@<server-ip>"
  exit 1
fi

REMOTE_ROOT="/opt/gi-training"

echo "=== Creating remote directory ==="
ssh "$SERVER" "mkdir -p $REMOTE_ROOT/packages/gi-agent $REMOTE_ROOT/scripts"

echo "=== Uploading plan-phases ==="
scp -r packages/gi-agent/plan-phases/ "$SERVER:$REMOTE_ROOT/packages/gi-agent/plan-phases/"

echo "=== Uploading LLM cache ==="
if [ -d "packages/gi-agent/.llm-deck-cache" ]; then
  scp -r packages/gi-agent/.llm-deck-cache/ "$SERVER:$REMOTE_ROOT/packages/gi-agent/.llm-deck-cache/"
fi

echo "=== Uploading benchmark ==="
scp packages/gi-agent/benchmark.training-v3.json "$SERVER:$REMOTE_ROOT/packages/gi-agent/"

echo "=== Uploading scripts ==="
scp scripts/cloud-deploy.sh scripts/cloud-train.sh "$SERVER:$REMOTE_ROOT/scripts/"

echo "=== Uploading repo (excluding large output/deps) ==="
# Use rsync for efficiency — skip node_modules, output, .git
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude 'output' \
  --exclude '.llm-deck-cache' \
  --exclude 'plan-phases' \
  --exclude '*.stackdump' \
  --exclude '.tmp' \
  ./ "$SERVER:$REMOTE_ROOT/"

echo ""
echo "=== Upload complete ==="
echo "Now SSH in and run:"
echo "  ssh $SERVER"
echo "  cd $REMOTE_ROOT"
echo "  bash scripts/cloud-deploy.sh"
echo "  bash scripts/cloud-train.sh"
