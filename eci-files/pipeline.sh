#!/bin/bash
# Pipeline: Self-Play → Train → Benchmark (10-deck, 1000 games)
# Bootstrap phase: Greedy gi-ml-runtime vs baseline
set -eu
STAGE=0
fail() { echo "❌ STAGE $STAGE FAILED at $(date -u +%H:%M:%S)"; exit 1; }
trap fail ERR

APP=/app
CAPTURE_DIR=$APP/rl-capture-v15
DATASET_DIR=$APP/rl-dataset-v15
ARTIFACT_DIR=$APP/v15-artifacts
RESULTS_DIR=$APP/results
BENCH_RESULTS_DIR=$APP/bench-results
LOGDIR=$APP/pipeline-logs

mkdir -p $CAPTURE_DIR $DATASET_DIR $ARTIFACT_DIR $RESULTS_DIR $BENCH_RESULTS_DIR $LOGDIR

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

log "══════════ Pipeline Start: V15 Greedy 10-Deck ══════════"

# ── Diagnostic: verify config at runtime (ImageCache poisoning check) ──
log "── Config Diagnostic ──"
bun -e "
const sp = require('$APP/self-play-wrapper.json');
const bp = require('$APP/bench-config.json');
console.log('DIAG: self-play kind=' + sp.sideA.kind + ' temp=' + sp.sideA.options.temperature);
console.log('DIAG: benchmark  kind=' + bp.matchups[0].sideA.kind + ' matchups=' + bp.matchups.length + ' games=' + bp.matchups[0].games);
console.log('DIAG: ranker=' + (bp.matchups[0].sideA.rankerArtifactPath || 'NONE'));
"

# ── Stage 1: Self-Play ──
STAGE=1
log "══════════ Stage 1/5: Self-Play (100 matchups × 10 games = 1000) ══════"
cd $APP/packages/gi-agent
bun run --smol src/learning/self-play/run-self-play.ts \
  $APP/self-play-wrapper.json \
  --progress-file $LOGDIR/selfplay-progress.txt
N=$(find $CAPTURE_DIR -type f 2>/dev/null | wc -l)
log "Self-play done. Capture files: $N"

# ── Persist self-play capture files to NAS (for post-training analysis) ──
if mountpoint -q /mnt/nas 2>/dev/null; then
  NAS_DIR=/mnt/nas/v15-greedy-10deck
  mkdir -p $NAS_DIR/capture
  cp -r $CAPTURE_DIR/* $NAS_DIR/capture/ 2>/dev/null || true
  NAS_N=$(find $NAS_DIR/capture -type f 2>/dev/null | wc -l)
  log "Self-play captures synced to NAS: $NAS_DIR/capture ($NAS_N files)"
fi

# ── Stage 2: Export RL Dataset ──
STAGE=2
log "══════════ Stage 2/5: Export RL Dataset ══════"
cd $APP/packages/gi-agent
bun run --smol src/learning/rl/run-export-rl-dataset.ts \
  --input $CAPTURE_DIR \
  --output $DATASET_DIR/rl-dataset.json \
  --output-manifest $DATASET_DIR/rl-dataset.manifest.json \
  --max-samples-per-shard 2000
log "Export done. Manifest: $(wc -c < $DATASET_DIR/rl-dataset.manifest.json) bytes"

# ── Stage 3: Streaming Ranker (Linear + Value) ──
STAGE=3
log "══════════ Stage 3/5: Train Ranker + Value (Streaming) ══════"
cd $APP/packages/gi-ml
bun --smol run src/cli/run-build-ranker-streaming.ts \
  --manifest $DATASET_DIR/rl-dataset.manifest.json \
  --output-dir $ARTIFACT_DIR --prefix v15 \
  --top-candidate-slots 64 --top-tags 32 \
  --artifact-version v15_greedy_10deck

# Health check
bun -e "
const a = require('$ARTIFACT_DIR/v15.ranker-artifact.json');
const b = a.config.action_case_bias || {};
const de = b.declareEnd || 0;
const us = b.useSkill || 0;
console.log('HEALTH: declareEnd=' + de.toFixed(2) + ' useSkill=' + us.toFixed(2));
if (de > 3) { console.log('⚠️ HIGH declareEnd bias — may cause passivity'); }
if (us < 0) { console.log('⚠️ NEGATIVE useSkill — artifact degraded'); }
"
log "Ranker artifact: $(wc -c < $ARTIFACT_DIR/v15.ranker-artifact.json) bytes"

# ── Immediately sync artifacts to NAS ──
if mountpoint -q /mnt/nas 2>/dev/null; then
  NAS_DIR=/mnt/nas/v15-greedy-10deck
  mkdir -p $NAS_DIR/artifacts
  cp -r $ARTIFACT_DIR/* $NAS_DIR/artifacts/ 2>/dev/null || true
  log "Artifacts synced to NAS: $NAS_DIR/artifacts"
fi

# ── Stage 4: Generate Bench Config with trained artifacts ──
STAGE=4
log "══════════ Stage 4/5: Generate Benchmark Config ══════"
bun -e "
const fs = require('fs');
const bc = require('$APP/bench-config.json');
for (const m of bc.matchups) {
  m.sideA.rankerArtifactPath = '$ARTIFACT_DIR/v15.ranker-artifact.json';
  m.sideA.valueArtifactPath = '$ARTIFACT_DIR/v15.value-artifact.json';
  m.sideA.name = 'V15-Greedy-10Deck';
}
fs.writeFileSync('$APP/bench-pipeline-config.json', JSON.stringify(bc));
console.log('Generated bench-pipeline-config.json: ' + bc.matchups.length + ' matchups');
"

# ── Stage 5: Benchmark ──
STAGE=5
log "══════════ Stage 5/5: Benchmark (1000 games) ══════"
cd $APP/packages/gi-agent
bun run --smol src/evaluation/benchmark/run-benchmark.ts \
  $APP/bench-pipeline-config.json \
  --output $RESULTS_DIR/bench-out.json \
  --output-dir $BENCH_RESULTS_DIR \
  --markdown $RESULTS_DIR/bench-report.md \
  --concurrency 4
log "Benchmark done."

# ── Immediately sync benchmark results to NAS ──
if mountpoint -q /mnt/nas 2>/dev/null; then
  NAS_DIR=/mnt/nas/v15-greedy-10deck
  mkdir -p $NAS_DIR/results $NAS_DIR/bench-results
  cp -r $RESULTS_DIR/* $NAS_DIR/results/ 2>/dev/null || true
  cp -r $BENCH_RESULTS_DIR/* $NAS_DIR/bench-results/ 2>/dev/null || true
  log "Benchmark results synced to NAS: $NAS_DIR/results + $NAS_DIR/bench-results"
fi

# ── Summary ──
bun -e "
const fs = require('fs');
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

# ── NAS Sync ──
if mountpoint -q /mnt/nas 2>/dev/null; then
  log "── Syncing to NAS ──"
  NAS_DIR=/mnt/nas/v15-greedy-10deck
  mkdir -p $NAS_DIR/artifacts $NAS_DIR/results $NAS_DIR/bench-results
  cp -r $ARTIFACT_DIR/* $NAS_DIR/artifacts/ 2>/dev/null || true
  cp -r $RESULTS_DIR/* $NAS_DIR/results/ 2>/dev/null || true
  cp -r $BENCH_RESULTS_DIR/* $NAS_DIR/bench-results/ 2>/dev/null || true
  cp $LOGDIR/selfplay-progress.txt $NAS_DIR/ 2>/dev/null || true
  log "NAS sync done: $NAS_DIR"
else
  log "⚠️ NAS not mounted — results only on ephemeral disk"
fi

log "══════════ PIPELINE COMPLETE ══════════"
sleep 120
