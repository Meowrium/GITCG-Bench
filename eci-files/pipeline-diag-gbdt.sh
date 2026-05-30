#!/bin/bash
# Pipeline DIAGNOSTIC: Load existing v16 artifacts from NAS, verify GBDT, run minimal bench
# Skips self-play + training — uses artifacts from previous run at /mnt/nas/v16-mcts400-gbdt/
set -eu
STAGE=0
fail() { echo "❌ STAGE $STAGE FAILED at $(date -u +%H:%M:%S)"; exit 1; }
trap fail ERR

APP=/app
ARTIFACT_DIR=$APP/v16-artifacts
RESULTS_DIR=$APP/results
BENCH_RESULTS_DIR=$APP/bench-results
LOGDIR=$APP/pipeline-logs
NAS_ARTIFACTS=/mnt/nas/v16-mcts400-gbdt/artifacts
mkdir -p $ARTIFACT_DIR $RESULTS_DIR $BENCH_RESULTS_DIR $LOGDIR

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

log "══════════ DIAGNOSTIC: Load artifacts + test GBDT ══════════"

# ── Stage 0: Load artifacts from NAS ──
STAGE=0
log "══════════ Stage 0: Load NAS Artifacts ══════"
if ! mountpoint -q /mnt/nas; then
  log "❌ NAS not mounted!"
  exit 1
fi
if [ ! -f "$NAS_ARTIFACTS/v16.gbdt-value-artifact.json" ]; then
  log "❌ NAS artifacts not found at $NAS_ARTIFACTS/"
  ls -la $NAS_ARTIFACTS/ 2>/dev/null || echo "(directory empty or missing)"
  exit 1
fi
cp -v $NAS_ARTIFACTS/* $ARTIFACT_DIR/ 2>&1
log "✓ Artifacts loaded: $(ls $ARTIFACT_DIR/ | wc -l) files"

# ── Stage 1: Sample-predict sanity test ──
STAGE=1
log "══════════ Stage 1: GBDT Sample Predict ══════"
cd $APP/packages/gi-agent
bun --smol -e "
const fs = require('fs');

// Dynamic import for ESM modules
async function main() {
  const { createGbdtValueFn } = await import('./src/mcts/value-features.js');

  const artifactPath = '$ARTIFACT_DIR/v16.gbdt-value-artifact.json';
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  console.log('Artifact type:', artifact.artifact_type);
  console.log('Trees:', artifact.trees?.length);
  console.log('Bias:', artifact.bias?.toFixed(4));
  console.log('LR:', artifact.learning_rate);
  console.log('Feature count:', artifact.feature_names?.length);

  // Build a test snapshot — LeiHe (Raiden+Shenhe+Chongyun) vs ShenXiao (Yoimiya+Ayaka+Xingqiu)
  const snap = {
    who: 0, chars: [
      { id: 1, definitionId: 1407, hp: 10, maxHp: 10, energy: 2, maxEnergy: 3, alive: true, aura: 7, equipDefIds: [] },
      { id: 2, definitionId: 1105, hp: 10, maxHp: 10, energy: 1, maxEnergy: 2, alive: true, aura: 1, equipDefIds: [] },
      { id: 3, definitionId: 1601, hp: 10, maxHp: 10, energy: 0, maxEnergy: 2, alive: true, aura: 2, equipDefIds: [] }
    ], activeIdx: 0,
    dice: [0,0,0,0,0,0,0,0,3,3,0,0,0,0,0,0],
    handDefIds: [330011, 332001, 311101, 321001],
    supports: [], summons: [], combatStatuses: [],
    declaredEnd: false, roundNumber: 2
  };
  const oppSnap = {
    who: 1, chars: [
      { id: 4, definitionId: 1305, hp: 8, maxHp: 10, energy: 2, maxEnergy: 2, alive: true, aura: 7, equipDefIds: [] },
      { id: 5, definitionId: 1503, hp: 10, maxHp: 10, energy: 0, maxEnergy: 3, alive: true, aura: 5, equipDefIds: [] },
      { id: 6, definitionId: 1203, hp: 10, maxHp: 10, energy: 0, maxEnergy: 2, alive: true, aura: 3, equipDefIds: [] }
    ], activeIdx: 0,
    dice: [0,0,0,0,0,0,0,0,2,2,0,0,0,0,0,0],
    handDefIds: [],
    supports: [], summons: [], combatStatuses: [],
    declaredEnd: false, roundNumber: 2
  };

  const gbdtFn = createGbdtValueFn(artifact);
  if (!gbdtFn) { console.log('❌ createGbdtValueFn returned null!'); process.exit(1); }
  console.log('✓ createGbdtValueFn created');

  const value = gbdtFn(snap, oppSnap);
  console.log('GBDT prediction:', value?.toFixed(4));

  if (value == null || isNaN(value)) {
    console.log('❌ GBDT returned null/NaN!');
    process.exit(1);
  }
  if (value === 0) {
    console.log('⚠️ GBDT returned exactly 0.0 — possible silent prediction failure (error caught)');
  } else if (value < 0.01 || value > 0.99) {
    console.log('⚠️ GBDT returned extreme value (' + value.toFixed(4) + ')');
  }
  console.log('✓ Sample predict OK');

  // Also test a clearly winning position (opponent has 1 HP, we have full)
  const winSnap = { ...snap };
  const winOpp = { ...oppSnap, chars: [
    { id: 4, definitionId: 1305, hp: 1, maxHp: 10, energy: 0, maxEnergy: 2, alive: true, aura: 0, equipDefIds: [] },
    { id: 5, definitionId: 1503, hp: 10, maxHp: 10, energy: 0, maxEnergy: 3, alive: true, aura: 5, equipDefIds: [] },
    { id: 6, definitionId: 1203, hp: 10, maxHp: 10, energy: 0, maxEnergy: 2, alive: true, aura: 3, equipDefIds: [] }
  ]};
  const winValue = gbdtFn(winSnap, winOpp);
  console.log('GBDT value (winning pos):', winValue?.toFixed(4));

  // And a losing position (we have 1 HP)
  const loseSnap = { ...snap, chars: [
    { id: 1, definitionId: 1407, hp: 1, maxHp: 10, energy: 0, maxEnergy: 3, alive: true, aura: 0, equipDefIds: [] },
    { id: 2, definitionId: 1105, hp: 10, maxHp: 10, energy: 0, maxEnergy: 2, alive: true, aura: 1, equipDefIds: [] },
    { id: 3, definitionId: 1601, hp: 10, maxHp: 10, energy: 0, maxEnergy: 2, alive: true, aura: 2, equipDefIds: [] }
  ]};
  const loseValue = gbdtFn(loseSnap, oppSnap);
  console.log('GBDT value (losing pos):', loseValue?.toFixed(4));

  if (winValue <= loseValue) {
    console.log('⚠️ WARNING: Winning position value (' + winValue.toFixed(4) + ') <= losing position value (' + loseValue.toFixed(4) + ')');
    console.log('   → GBDT may have REVERSED polarity!');
  } else {
    console.log('✓ Value ordering correct: win(' + winValue.toFixed(4) + ') > lose(' + loseValue.toFixed(4) + ')');
  }
}

main().catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
" 2>&1
log "Sample predict done"

# ── Stage 2: Generate minimal bench config ──
STAGE=2
log "══════════ Stage 2: Generate Minimal Bench Config ══════"
bun -e "
const fs = require('fs');
const bc = JSON.parse(fs.readFileSync('$APP/bench-config.json', 'utf8'));
bc.matchups = bc.matchups.slice(0, 2);
for (const m of bc.matchups) {
  m.games = 5;
  m.sideA.kind = 'mcts-gi-ml';
  m.sideA.rankerArtifactPath = '$ARTIFACT_DIR/v16.ranker-artifact.json';
  m.sideA.gbdtRankerArtifactPath = '$ARTIFACT_DIR/v16.ranker-artifact.json';
  m.sideA.valueArtifactPath = '$ARTIFACT_DIR/v16.gbdt-value-artifact.json';
  m.sideA.name = 'V16-DIAG-MCTS400-GBDT';
  m.sideA.v2Enabled = true;
  m.sideA.options = m.sideA.options || {};
  m.sideA.options.endTurnPenalty = 5;
  m.sideA.options.temperature = 1.0;
  m.sideA.options.mctsIterations = 400;
  m.sideA.options.mctsTemperature = 0.5;
}
fs.writeFileSync('$APP/bench-diag-config.json', JSON.stringify(bc));
const totalGames = bc.matchups.reduce((s,m) => s + m.games, 0);
console.log('Matchups: ' + bc.matchups.length + ', Games: ' + totalGames);
console.log('mctsIterations: ' + bc.matchups[0].sideA.options.mctsIterations);
console.log('kind: ' + bc.matchups[0].sideA.kind);
" 2>&1

# ── Stage 3: Benchmark ──
STAGE=3
log "══════════ Stage 3: Benchmark ══════"
cd $APP/packages/gi-agent
bun --smol run src/evaluation/benchmark/run-benchmark.ts \
  $APP/bench-diag-config.json \
  --output $RESULTS_DIR/bench-out.json \
  --output-dir $BENCH_RESULTS_DIR \
  --markdown $RESULTS_DIR/bench-report.md \
  --concurrency 1

# ── Summary ──
log "══════════ Summary ══════"
bun -e "
const d = require('$RESULTS_DIR/bench-out.json');
let wins = 0, total = 0;
for (const r of (d.matchups || [])) {
  wins += (r.winsP0 || 0);
  total += (r.total || 0);
}
const wr = total > 0 ? (wins / total * 100).toFixed(1) : '?';
console.log('WR: ' + wr + '% (' + wins + '/' + total + ' games)');
console.log('Avg rounds: ' + ((d.summary?.meanRounds || 0).toFixed(1)));
for (const r of (d.matchups || [])) {
  console.log(r.matchupId + ': ' + r.sideAName + ' vs ' + r.sideBName + ' -> ' + (r.winRateP0*100).toFixed(0) + '% (' + r.winsP0 + '-' + r.winsP1 + '-' + r.draws + ')');
}
" 2>&1

# ── NAS sync results ──
if mountpoint -q /mnt/nas 2>/dev/null; then
  NAS_DIR=/mnt/nas/v16-diag-test
  mkdir -p $NAS_DIR
  cp -r $RESULTS_DIR/* $NAS_DIR/ 2>/dev/null || true
  cp -r $BENCH_RESULTS_DIR/* $NAS_DIR/ 2>/dev/null || true
  log "Results synced to NAS: $NAS_DIR"
fi

log "══════════ DIAGNOSTIC COMPLETE ══════════"
sleep 60
