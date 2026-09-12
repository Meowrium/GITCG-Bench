#!/bin/bash
# ==============================================================
#  Cloud Training Script — Genius Invokation TCG AL Pipeline
# ==============================================================
#
# Runs the multi-iteration training pipeline on a cloud server.
# Configure the parameters below before running.
#
# Usage:  bash scripts/cloud-train.sh

set -euo pipefail

export PATH="$HOME/.bun/bin:$PATH"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ══════════════════════════════════════════════════════════════
# ▼▼▼ Server Resource Tuning — ADJUST THESE ▼▼▼
# ══════════════════════════════════════════════════════════════

# Number of parallel bun self-play processes.
# Set to (CPU_CORES / 2), minimum 2, maximum 8.
# Each bun process uses ~1.5GB RAM during self-play.
# Game simulation is single-threaded, so this is the primary
# way to utilize multi-core CPUs.
CONCURRENCY=4

# Self-play chunk size: how many matchups to process per chunk.
# Smaller = less peak memory, more disk I/O.
# On NVMe SSD: 0 (no chunking, fastest).
# On SSD with < 32GB RAM: 8-16 (balance memory vs I/O).
SELF_PLAY_CHUNK_SIZE=0

# Number of training iterations (1 = single round of self-play + train).
START_ITER=1
END_ITER=5

# Games multiplier: primary self-play games = benchmark.games × this.
# 3 = ~1248 games (good balance of data quality vs time).
# 5 = ~2080 games (more data, slower).
GAMES_MULTIPLIER=3

# LightGBM hyperparameters — adjust for CPU core count
# More estimators = better model, slower training
GBDT_ESTIMATORS=120
GBDT_DEPTH=5
GBDT_LR=0.06

# Side B (opponent) strategy: "mixed" = diverse + baseline, "diverse" = high-temp only
SIDE_B_STRATEGY="mixed"

# Promotion strategy: "winrate" = new model vs old model head-to-head
PROMOTION_STRATEGY="winrate"
WINRATE_THRESHOLD=0.55

# Output root directory
OUTPUT_ROOT="/opt/data/gi-training/output"

# ══════════════════════════════════════════════════════════════
# ▼▼▼ LLM Deck Analysis (set DECK_ANALYZER_API_KEY to enable) ▼▼▼
# ══════════════════════════════════════════════════════════════

LLM_CACHE_DIR=""
if [ -d "./packages/gi-agent/.llm-deck-cache" ]; then
  LLM_CACHE_DIR="$(realpath ./packages/gi-agent/.llm-deck-cache)"
  echo "LLM analysis cache detected: $LLM_CACHE_DIR"
fi

PYTHON_VENV="$REPO_ROOT/packages/gi-ml/python/.lgbm-venv"
if [ -f "$PYTHON_VENV/bin/activate" ]; then
  source "$PYTHON_VENV/bin/activate"
fi

# ══════════════════════════════════════════════════════════════
# ▼▼▼ Execution ▼▼▼
# ══════════════════════════════════════════════════════════════

START_TIME=$(date +%s)

echo "========================================================"
echo "  CLOUD TRAINING — Genius Invokation TCG"
echo "========================================================"
echo "  CPU cores:     $(nproc)"
echo "  RAM:           $(free -h | awk '/Mem:/{print $2}')"
echo "  Disk:          $(df -h /opt/gi-training 2>/dev/null || df -h / | tail -1 | awk '{print $2}')"
echo "  Concurrency:   $CONCURRENCY"
echo "  Iterations:    $START_ITER → $END_ITER"
echo "  Games mult:    ${GAMES_MULTIPLIER}x"
echo "  GBDT trees:    $GBDT_ESTIMATORS"
echo "  Side B:        $SIDE_B_STRATEGY"
echo ""

# ── Skip build — bun runs .ts directly; only need deps installed ──
echo "Skipping build (bun runs .ts directly)..."
echo ""

cd "$REPO_ROOT/packages/gi-agent"

# Build the PowerShell argument list for run-multi-iteration-training.ps1
# Note: on Linux we can't run .ps1 directly. We use pwsh if available, or extract the logic.

if command -v pwsh &>/dev/null; then
  echo "Running with PowerShell Core..."

  LLM_ARGS=""
  if [ -n "$LLM_CACHE_DIR" ]; then
    LLM_ARGS="-LlmCacheDir \"$LLM_CACHE_DIR\""
  fi

  pwsh -File ../../scripts/run-multi-iteration-training.ps1 \
    -StartIteration $START_ITER \
    -EndIteration $END_ITER \
    -GamesMultiplier $GAMES_MULTIPLIER \
    -Concurrency $CONCURRENCY \
    -SideBStrategy "$SIDE_B_STRATEGY" \
    -GbdtEstimators $GBDT_ESTIMATORS \
    -GbdtDepth $GBDT_DEPTH \
    -GbdtLr $GBDT_LR \
    -SelfPlayChunkSize $SELF_PLAY_CHUNK_SIZE \
    -PromotionStrategy "$PROMOTION_STRATEGY" \
    -WinRateThreshold $WINRATE_THRESHOLD \
    -OutputRoot "$OUTPUT_ROOT" \
    $LLM_ARGS

else
  echo "PowerShell Core not found — running Bun scripts directly..."

  # ── Manual pipeline (Linux-native, no PowerShell) ──
  ITER_DIR_BASE="$OUTPUT_ROOT"
  STATE_FILE="$ITER_DIR_BASE/pipeline-state.json"
  BENCHMARK="$(realpath ./benchmark.training-v3.json)"

  for ITER in $(seq $START_ITER $END_ITER); do
    ITER_DIR="$ITER_DIR_BASE/iter-$(printf '%03d' $ITER)"
    RL_DIR="$ITER_DIR/self-play-rl"
    ART_DIR="$ITER_DIR/artifacts"

    mkdir -p "$ITER_DIR" "$RL_DIR" "$ART_DIR"

    echo ""
    echo "===== ITERATION $ITER / $END_ITER ====="
    echo ""

    # Build self-play config JSON (simplified — uses heuristic if no prev model)
    SELF_PLAY_CFG="$ITER_DIR/self-play-config.json"
    if [ ! -f "$SELF_PLAY_CFG" ]; then
      # Check for previous best model
      PREV_RANKER=""
      PREV_VALUE=""
      if [ -f "$STATE_FILE" ]; then
        PREV_RANKER=$(bun -e "const s=require('$STATE_FILE');process.stdout.write(s.currentBestRankerPath||'')")
        PREV_VALUE=$(bun -e "const s=require('$STATE_FILE');process.stdout.write(s.currentBestValuePath||'')")
      fi

      if [ -n "$PREV_RANKER" ] && [ -f "$PREV_RANKER" ]; then
        SIDE_A=$(cat <<ENDCFG
{
  "name": "trained-iter$ITER",
  "kind": "gi-ml-runtime",
  "rankerArtifactPath": "$PREV_RANKER",
  "options": { "endTurnPenalty": 5, "temperature": 1.5 }
}
ENDCFG
)
      else
        SIDE_A='{"name": "baseline", "kind": "baseline", "options": { "endTurnPenalty": 5, "temperature": 1.5 }}'
      fi

      SIDE_B='{"name": "opponent-diverse", "kind": "baseline", "options": { "endTurnPenalty": 5, "temperature": 2.0, "adaptiveProfile": true }}'

      # Paths must be relative to config file directory (ITER_DIR),
      # because run-self-play-rl-smoke.ts resolves them via resolve(configDir, path).
      bun -e "
const cfg = {
  benchmarkPath: '$BENCHMARK',
  gamesMultiplier: $GAMES_MULTIPLIER,
  rlCapture: {
    directory: 'self-play-rl',
    modelVersion: 'iter-$ITER',
    viewKind: 'policy_public',
    gameVersion: 'v6.3.0',
    cardPoolVersion: 'v6.3.0',
    rulesetVersion: 'default',
    contractVersion: 'obs.v1'
  },
  dataset: {
    manifestPath: 'rl-dataset.manifest.json',
    shardDir: 'rl-dataset.shards',
    maxSamplesPerShard: 2000,
    includeSides: [0, 1],
    requireChosenCandidate: true
  },
  sideA: $SIDE_A,
  sideB: $SIDE_B,
  outputPath: 'self-play-result.json'
}
$(if [ -n "$LLM_CACHE_DIR" ]; then echo "cfg.llmCacheDir = '$LLM_CACHE_DIR'"; fi)
require('fs').writeFileSync('$SELF_PLAY_CFG', JSON.stringify(cfg, null, 2))
"
      echo "  Config: $SELF_PLAY_CFG"
    fi

    # Self-play
    echo "  [Step 1] Self-play..."
    if [ ! -f "$ITER_DIR/rl-dataset.manifest.json" ]; then
      bun run --smol src/learning/rl/cli/run-self-play-rl-smoke.ts "$SELF_PLAY_CFG"
    else
      echo "  Dataset exists, skip."
    fi

    # Train
    echo "  [Step 2] Training models..."
    RL_DATASET="$ITER_DIR/rl-dataset.manifest.json"
    BUNDLE="$ART_DIR/iter${ITER}.bundle.json"
    GBDT_VALUE="$ART_DIR/iter${ITER}.gbdt-value-artifact.json"

    if [ -f "$RL_DATASET" ] && [ ! -f "$BUNDLE" ]; then
      cd "$REPO_ROOT/packages/gi-ml"
      bun run ./src/cli/run-build-rl-warm-start-bundle.ts \
        --input "$RL_DATASET" --output-dir "$ART_DIR" --prefix "iter${ITER}" \
        --top-tags 32 --top-candidate-slots 24 --top-features 32

      # LightGBM value
      bun run ./src/cli/run-build-lgbm-value.ts \
        --input "$RL_DATASET" --output-dir "$ART_DIR" --prefix "iter${ITER}" \
        --estimators $GBDT_ESTIMATORS --depth $GBDT_DEPTH --lr $GBDT_LR --top-features 80

      # LightGBM Q-value
      bun run ./src/cli/run-build-lgbm-q-value.ts \
        --input "$RL_DATASET" --output-dir "$ART_DIR" --prefix "iter${ITER}" \
        --estimators $GBDT_ESTIMATORS --depth $GBDT_DEPTH --lr $GBDT_LR --top-features 80

      cd "$REPO_ROOT/packages/gi-agent"
    fi

    # Update state
    RANKER_ART="$ART_DIR/iter${ITER}.ranker-artifact.json"
    if [ -f "$RANKER_ART" ] && [ -f "$GBDT_VALUE" ]; then
      bun -e "
const state = require('fs').existsSync('$STATE_FILE')
  ? require('$STATE_FILE')
  : { iterations: [], startedAt: new Date().toISOString() }
state.currentBestIteration = $ITER
state.currentBestRankerPath = '$RANKER_ART'
state.currentBestValuePath = '$GBDT_VALUE'
state.lastUpdatedAt = new Date().toISOString()
state.iterations.push({
  iteration: $ITER,
  promoted: true,
  artifactPaths: { ranker: '$RANKER_ART', value: '$GBDT_VALUE' }
})
require('fs').writeFileSync('$STATE_FILE', JSON.stringify(state, null, 2))
"
      echo "  Iteration $ITER promoted."
    fi

    # Cleanup: remove self-play RL captures, dataset shards, and intermediate files.
    # Keep only artifacts (trained models) and self-play-config.json for reference.
    rm -rf "$RL_DIR" \
           "$ITER_DIR/rl-dataset.shards" \
           "$ITER_DIR/rl-dataset.manifest.json" \
           "$ITER_DIR/self-play-result.json" \
           2>/dev/null || true
  done
fi

ELAPSED=$(($(date +%s) - START_TIME))
echo ""
echo "========================================================"
echo "  Training complete in $(($ELAPSED / 60)) minutes"
echo "  Output: $OUTPUT_ROOT"
echo "========================================================"
