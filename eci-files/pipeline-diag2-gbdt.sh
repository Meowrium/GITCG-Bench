#!/bin/bash
set -eu
STAGE=0
fail() { echo "❌ FAIL at $(date -u +%H:%M:%S)"; exit 1; }
trap fail ERR

APP=/app
ARTIFACT_DIR=$APP/v16-artifacts
NAS_ARTIFACTS=/mnt/nas/v16-mcts400-gbdt/artifacts
mkdir -p $ARTIFACT_DIR

log() { echo "[$(date -u +%H:%M:%S)] $*"; }
log "═══ DIAG V2b: MCTS leaf eval logging ═══"

mountpoint -q /mnt/nas || { log "❌ NAS not mounted!"; exit 1; }
cp -v $NAS_ARTIFACTS/v16.gbdt-value-artifact.json $NAS_ARTIFACTS/v16.ranker-artifact.json $ARTIFACT_DIR/
log "Artifacts loaded"

# Copy diag script to gi-agent and run from there (workspace resolution)
cp $APP/eci-files/diag-mcts-value.ts $APP/packages/gi-agent/diag-mcts-value.ts
cd $APP/packages/gi-agent
bun --smol run diag-mcts-value.ts 2>&1

log "═══ DIAG COMPLETE ═══"
sleep 30
