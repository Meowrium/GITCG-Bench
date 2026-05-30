#!/bin/bash
# Pipeline V16: MCTS 400it Self-Play → GBDT Train → Benchmark
# 10-deck, spot ECI, single-shot (no iteration)
set -eu
STAGE=0
fail() { echo "❌ STAGE $STAGE FAILED at $(date -u +%H:%M:%S)"; exit 1; }
trap fail ERR

APP=/app
CAPTURE_DIR=$APP/rl-capture-v16
DATASET_DIR=$APP/rl-dataset-v16
ARTIFACT_DIR=$APP/v16-artifacts
RESULTS_DIR=$APP/results
BENCH_RESULTS_DIR=$APP/bench-results
LOGDIR=$APP/pipeline-logs

mkdir -p $CAPTURE_DIR $DATASET_DIR $ARTIFACT_DIR $RESULTS_DIR $BENCH_RESULTS_DIR $LOGDIR

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

MAX_CAPTURES=1500  # 8xlarge (64GB) + --smol: 1500 captures → ~180K samples safe from JIT crash (~39GB threshold)

log "══════════ Pipeline Start: V16 MCTS400 + GBRL→LightGBM ══════════"

# ── Fast path: check if self-play captures already on NAS ──
SKIP_STAGE1=false
if mountpoint -q /mnt/nas 2>/dev/null && [ -d /mnt/nas/v16-mcts400-gbdt/capture ]; then
  NAS_CAPTURES=$(find /mnt/nas/v16-mcts400-gbdt/capture -type f 2>/dev/null | wc -l)
  if [ "$NAS_CAPTURES" -ge 100 ]; then
    if [ "$NAS_CAPTURES" -gt "$MAX_CAPTURES" ]; then
      log "□ Found $NAS_CAPTURES captures on NAS, limiting to $MAX_CAPTURES (first N)"
      ls /mnt/nas/v16-mcts400-gbdt/capture/ | head -n $MAX_CAPTURES | while read entry; do
        cp -r "/mnt/nas/v16-mcts400-gbdt/capture/$entry" "$CAPTURE_DIR/"
      done
    else
      log "□ Found $NAS_CAPTURES captures on NAS, skipping Stage 1 (self-play)"
      cp -r /mnt/nas/v16-mcts400-gbdt/capture/* $CAPTURE_DIR/ 2>/dev/null || true
    fi
    SKIP_STAGE1=true
    N=$(find $CAPTURE_DIR -type f 2>/dev/null | wc -l)
    log "□ Copied $N captures from NAS to local"
  fi
fi

# ── Stage 1: MCTS Self-Play ──
if [ "$SKIP_STAGE1" = false ]; then
STAGE=1
log "══════════ Stage 1/5: MCTS-400 Self-Play ══════"
cd $APP/packages/gi-agent
bun --smol run src/learning/self-play/run-self-play.ts \
  $APP/self-play-mcts.json
N=$(find $CAPTURE_DIR -type f 2>/dev/null | wc -l)
log "Self-play done. Capture files: $N"

# ── NAS sync: self-play captures ──
if mountpoint -q /mnt/nas 2>/dev/null; then
  NAS_DIR=/mnt/nas/v16-mcts400-gbdt
  mkdir -p $NAS_DIR/capture
  cp -r $CAPTURE_DIR/* $NAS_DIR/capture/ 2>/dev/null || true
  log "Self-play captures synced to NAS: $NAS_DIR/capture"
fi
fi  # SKIP_STAGE1

# ── Fast path: check if training artifacts already on NAS ──
SKIP_TRAINING=false
if [ "$FORCE_RETRAIN" != "true" ] && mountpoint -q /mnt/nas 2>/dev/null && \
   [ -f /mnt/nas/v16-mcts400-gbdt/artifacts/v16.gbdt-value-artifact.json ] && \
   [ -f /mnt/nas/v16-mcts400-gbdt/artifacts/v16.ranker-artifact.json ]; then
  log "□ Found artifacts on NAS, skipping Stages 2-3 (training)"
  cp /mnt/nas/v16-mcts400-gbdt/artifacts/* $ARTIFACT_DIR/ 2>/dev/null || true
  SKIP_TRAINING=true
fi

# ── Stage 2: Export RL Dataset ──
if [ "$SKIP_TRAINING" = false ]; then
STAGE=2
log "══════════ Stage 2/5: Export RL Dataset ══════"
cd $APP/packages/gi-agent
bun --smol run src/learning/rl/run-export-rl-dataset.ts \
  --input $CAPTURE_DIR \
  --output $DATASET_DIR/rl-dataset.json \
  --output-manifest $DATASET_DIR/rl-dataset.manifest.json \
  --max-samples-per-shard 300
log "Export done. Manifest: $(wc -c < $DATASET_DIR/rl-dataset.manifest.json) bytes"

# ── Stage 3: Train GBDT (LightGBM) ──
STAGE=3
log "══════════ Stage 3/5: Train GBDT Value + Ranker ══════"

PYTHON_BIN=$(which python3 2>/dev/null || which python 2>/dev/null)
log "Python: $PYTHON_BIN ($($PYTHON_BIN --version 2>&1))"

cd $APP/packages/gi-ml

# Step 3a: Warm-start ranker bundle
log "  [3a] Building ranker bundle..."
bun --smol run src/cli/run-build-rl-warm-start-bundle.ts \
  --input $DATASET_DIR/rl-dataset.manifest.json \
  --output-dir $ARTIFACT_DIR --prefix v16 \
  --top-tags 32 --top-candidate-slots 24 --top-features 64
log "  Ranker bundle: $(wc -c < $ARTIFACT_DIR/v16.ranker-artifact.json) bytes"

# Step 3b: GBRL value model
log "  [3b] Training GBRL value model..."
bun --smol run src/cli/run-build-gbrl-value.ts \
  --input $DATASET_DIR/rl-dataset.manifest.json \
  --output-dir $ARTIFACT_DIR --prefix v16 \
  --estimators 120 --depth 5 --lr 0.06 --top-features 120 \
  --python $PYTHON_BIN
log "  GBDT value: $(wc -c < $ARTIFACT_DIR/v16.gbdt-value-artifact.json 2>/dev/null || echo 'MISSING')"

# Step 3c: GBDT Q-value model (optional, for richer leaf eval)
log "  [3c] Training GBDT Q-value model..."
bun --smol run src/cli/run-build-lgbm-q-value.ts \
  --input $DATASET_DIR/rl-dataset.manifest.json \
  --output-dir $ARTIFACT_DIR --prefix v16 \
  --estimators 120 --depth 5 --lr 0.06 --top-features 120 \
  --python $PYTHON_BIN 2>&1 | tail -5 || log "  ⚠️ Q-value training failed (non-fatal)"

# Health check
bun -e "
const a = require('$ARTIFACT_DIR/v16.ranker-artifact.json');
const b = a.config.action_case_bias || {};
const de = b.declareEnd || 0;
const us = b.useSkill || 0;
console.log('HEALTH: declareEnd=' + de.toFixed(2) + ' useSkill=' + us.toFixed(2));
if (de > 3) { console.log('⚠️ HIGH declareEnd bias'); }
if (us < 0) { console.log('⚠️ NEGATIVE useSkill'); }
"
log "Training complete."

# ── Stage 3.5: Artifact Verification + Sample Predict ──
STAGE=35
log "══════════ Stage 3.5/5: Artifact Verification ══════"
for f in "$ARTIFACT_DIR/v16.gbdt-value-artifact.json" "$ARTIFACT_DIR/v16.ranker-artifact.json"; do
  if [ -f "$f" ]; then log "  ✓ $(basename $f) ($(stat -c%s $f) bytes)"; else log "  ✗ MISSING: $f"; exit 1; fi
done
if [ -f "$ARTIFACT_DIR/v16.gbdt-q-value-artifact.json" ]; then log "  ✓ v16.gbdt-q-value-artifact.json ($(stat -c%s $ARTIFACT_DIR/v16.gbdt-q-value-artifact.json) bytes)"; fi

# Sample-predict sanity check
cd $APP/packages/gi-agent
bun --smol -e "
const fs = require('fs');
async function main() {
  const { createGbdtValueFn } = await import('./src/mcts/value-features.js');
  const artifact = JSON.parse(fs.readFileSync('$ARTIFACT_DIR/v16.gbdt-value-artifact.json','utf8'));
  const gbdtFn = createGbdtValueFn(artifact);
  if (!gbdtFn) { console.log('⚠️ createGbdtValueFn returned null'); process.exit(1); }
  // Simple test: snapshot with advantage → higher value
  const winningSnap = {who:0,chars:[{hp:10,maxHp:10,energy:2,maxEnergy:3,alive:true,aura:7,definitionId:1407,equipDefIds:[]},{hp:10,maxHp:10,energy:0,maxEnergy:2,alive:true,aura:1,definitionId:1105,equipDefIds:[]},{hp:10,maxHp:10,energy:0,maxEnergy:2,alive:true,aura:2,definitionId:1601,equipDefIds:[]}],activeIdx:0,dice:[0,0,0,0,0,0,0,0],handDefIds:[],supports:[],summons:[],combatStatuses:[],declaredEnd:false,roundNumber:2};
  const losingSnap = {who:0,chars:[{hp:1,maxHp:10,energy:0,maxEnergy:3,alive:true,aura:0,definitionId:1407,equipDefIds:[]},{hp:10,maxHp:10,energy:0,maxEnergy:2,alive:true,aura:1,definitionId:1105,equipDefIds:[]},{hp:10,maxHp:10,energy:0,maxEnergy:2,alive:true,aura:2,definitionId:1601,equipDefIds:[]}],activeIdx:0,dice:[0,0,0,0,0,0,0,0],handDefIds:[],supports:[],summons:[],combatStatuses:[],declaredEnd:false,roundNumber:2};
  const oppSnap = {who:1,chars:[{hp:10,maxHp:10,energy:2,maxEnergy:2,alive:true,aura:7,definitionId:1305,equipDefIds:[]},{hp:10,maxHp:10,energy:0,maxEnergy:3,alive:true,aura:5,definitionId:1503,equipDefIds:[]},{hp:10,maxHp:10,energy:0,maxEnergy:2,alive:true,aura:3,definitionId:1203,equipDefIds:[]}],activeIdx:0,dice:[0,0,0,0,0,0,0,0],handDefIds:[],supports:[],summons:[],combatStatuses:[],declaredEnd:false,roundNumber:2};
  const vWin = gbdtFn(winningSnap, oppSnap);
  const vLose = gbdtFn(losingSnap, oppSnap);
  console.log('Sample predict: win=' + vWin.toFixed(4) + ' lose=' + vLose.toFixed(4) + ' ✓' + (vWin > vLose ? ' (ordering OK)' : ' ⚠️ ORDERING WRONG'));
}
main();"
log "Artifact verification done."

# ── NAS sync: artifacts ──
if mountpoint -q /mnt/nas 2>/dev/null; then
  NAS_DIR=/mnt/nas/v16-mcts400-gbdt
  mkdir -p $NAS_DIR/artifacts
  cp -r $ARTIFACT_DIR/* $NAS_DIR/artifacts/ 2>/dev/null || true
  log "Artifacts synced to NAS"
fi

fi  # SKIP_TRAINING

# ── Stage 4: Generate Bench Config ──
STAGE=4
log "══════════ Stage 4/5: Generate Benchmark Config ══════"
bun -e "
const fs = require('fs');
const bc = require('$APP/bench-config.json');
for (const m of bc.matchups) {
  m.sideA.kind = 'mcts-gi-ml';
  m.sideA.rankerArtifactPath = '$ARTIFACT_DIR/v16.ranker-artifact.json';
  m.sideA.gbdtRankerArtifactPath = '$ARTIFACT_DIR/v16.ranker-artifact.json';
  m.sideA.valueArtifactPath = '$ARTIFACT_DIR/v16.gbdt-value-artifact.json';
  m.sideA.name = 'V16-MCTS400-GBRL';
  m.sideA.v2Enabled = true;
  m.sideA.options = m.sideA.options || {};
  m.sideA.options.endTurnPenalty = 5;
  m.sideA.options.temperature = 1.0;
  m.sideA.options.mctsIterations = 400;
  m.sideA.options.mctsTemperature = 0.5;
}
fs.writeFileSync('$APP/bench-pipeline-config.json', JSON.stringify(bc));
console.log('Generated bench config: ' + bc.matchups.length + ' matchups');
console.log('mctsIterations: ' + bc.matchups[0].sideA.options.mctsIterations);
console.log('kind: ' + bc.matchups[0].sideA.kind);
console.log('value: ' + bc.matchups[0].sideA.valueArtifactPath);
"

# ── Stage 5: Benchmark ──
STAGE=5
log "══════════ Stage 5/5: Benchmark ══════"
cd $APP/packages/gi-agent
bun --smol run src/evaluation/benchmark/run-benchmark.ts \
  $APP/bench-pipeline-config.json \
  --output $RESULTS_DIR/bench-out.json \
  --output-dir $BENCH_RESULTS_DIR \
  --markdown $RESULTS_DIR/bench-report.md \
  --concurrency 8
log "Benchmark done."

# ── Summary ──
bun -e "
const d = require('$RESULTS_DIR/bench-out.json');
const s = d.summary || {};
let wins = 0; let total = 0;
for (const r of (d.matchups || [])) {
  wins += (r.winsP0 || 0);
  total += (r.total || 0);
}
const wr = total > 0 ? (wins / total * 100).toFixed(1) : '?';
console.log('WR: ' + wr + '% (' + wins + '/' + total + ' games)');
console.log('Avg rounds: ' + ((s.meanRounds || 0).toFixed(1)));
"

# ── NAS Sync: full results ──
if mountpoint -q /mnt/nas 2>/dev/null; then
  NAS_DIR=/mnt/nas/v16-mcts400-gbdt
  mkdir -p $NAS_DIR/artifacts $NAS_DIR/results $NAS_DIR/bench-results
  cp -r $ARTIFACT_DIR/* $NAS_DIR/artifacts/ 2>/dev/null || true
  cp -r $RESULTS_DIR/* $NAS_DIR/results/ 2>/dev/null || true
  cp -r $BENCH_RESULTS_DIR/* $NAS_DIR/bench-results/ 2>/dev/null || true
  # selfplay-progress.txt removed (flag not supported by run-self-play.ts)
  log "NAS sync done: $NAS_DIR"
else
  log "⚠️ NAS not mounted — results only on ephemeral disk"
fi

log "══════════ PIPELINE COMPLETE ══════════"
sleep 120
