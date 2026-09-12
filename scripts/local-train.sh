#!/usr/bin/env bash
# ============================================================
#  LOCAL TRAINING PIPELINE (low-memory streaming mode)
# ============================================================
#
# Designed for machines with limited RAM (~8-16GB).
# Processes data shard-by-shard instead of loading everything at once.
#
# Usage (from packages/gi-agent/):
#   bash ../../scripts/local-train.sh
#
# Env vars:
#   GAMES_MULTIPLIER     Games per matchup multiplier (default: 1)
#   CONCURRENCY          Self-play concurrency (default: 2)
#   GBDT_ESTIMATORS      LightGBM trees (default: 80)
#   GBDT_TOP_FEATURES    LightGBM top features (default: 128)
#   MAX_SAMPLES          Max RL samples for GBDT (default: 40000)
#   RANKER_MAX_SHARDS    Max shards for ranker (default: 50, 0=all)
#   RUN_BENCHMARK        Run quick benchmark after training (default: false)
#   ITER_DIR             Output directory (default: output/local-training)
#
# Cloud mode (full memory):
#   MODE=cloud bash ../../scripts/local-train.sh
#   (uses run-multi-iteration-training.sh internally)

set -euo pipefail

# ════════════════════════════════════════════════════
# Configuration
# ════════════════════════════════════════════════════
MODE="${MODE:-local}"
GAMES_MULTIPLIER="${GAMES_MULTIPLIER:-1}"
CONCURRENCY="${CONCURRENCY:-2}"
GBDT_ESTIMATORS="${GBDT_ESTIMATORS:-80}"
GBDT_TOP_FEATURES="${GBDT_TOP_FEATURES:-128}"
MAX_SAMPLES="${MAX_SAMPLES:-40000}"
RANKER_MAX_SHARDS="${RANKER_MAX_SHARDS:-50}"
RUN_BENCHMARK="${RUN_BENCHMARK:-false}"
ITER_DIR="${ITER_DIR:-./output/local-training}"

BENCHMARK_CONFIG="${BENCHMARK_CONFIG:-./benchmark.training-v3.json}"
PLANS_DIR="${PLANS_DIR:-./plan-phases}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GI_AGENT_DIR="$(pwd)"
GI_ML_DIR="$GI_AGENT_DIR/../gi-ml"
LGBM_PYTHON="$GI_ML_DIR/python/.lgbm-venv/bin/python"
STREAM_TRAIN_PY="$SCRIPT_DIR/stream_train_lgbm.py"

START_TIME=$(date +%s)

echo ""
echo "============================================================"
echo "  LOCAL TRAINING PIPELINE (${MODE} mode)"
echo "============================================================"
echo "  Games multiplier:   ${GAMES_MULTIPLIER}x"
echo "  Concurrency:        ${CONCURRENCY}"
echo "  GBDT estimators:    ${GBDT_ESTIMATORS}"
echo "  GBDT top features:  ${GBDT_TOP_FEATURES}"
echo "  Max GBDT samples:   ${MAX_SAMPLES}"
echo "  Ranker max shards:  ${RANKER_MAX_SHARDS}"
echo "  Run benchmark:      ${RUN_BENCHMARK}"
echo "  Output:             ${ITER_DIR}"
echo ""

# ════════════════════════════════════════════════════
# Cloud mode: delegate to full pipeline
# ════════════════════════════════════════════════════
if [ "$MODE" = "cloud" ]; then
  echo "  → Delegating to multi-iteration training (cloud mode)..."
  exec bash "$SCRIPT_DIR/run-multi-iteration-training.sh"
fi

# ════════════════════════════════════════════════════
# Local mode: streaming pipeline
# ════════════════════════════════════════════════════

ensure_dir() { mkdir -p "$1"; }

format_duration() {
  local total_seconds=$1
  local minutes=$(( total_seconds / 60 ))
  local seconds=$(( total_seconds % 60 ))
  if [ "$minutes" -ge 1 ]; then
    echo "${minutes}m${seconds}s"
  else
    echo "${seconds}s"
  fi
}

ensure_dir "$ITER_DIR"
ART_DIR="$ITER_DIR/artifacts"
RL_DIR="$ITER_DIR/self-play-rl"
ensure_dir "$ART_DIR"
ensure_dir "$RL_DIR"

# ════════════════════════════════════════════════════
# Step 1: Self-play
# ════════════════════════════════════════════════════
SELF_PLAY_BENCHMARK="$ITER_DIR/self-play-benchmark.json"
SELF_PLAY_CONFIG="$ITER_DIR/self-play-config.json"
MANIFEST="$ITER_DIR/rl-dataset.manifest.json"
DIVERSE_SCRIPT="$GI_AGENT_DIR/scripts/gen_diverse_selfplay.py"
RANKER_BOOTSTRAP="$GI_AGENT_DIR/output/v5-model/iter3.ranker-artifact.json"

if [ ! -f "$MANIFEST" ]; then
  echo "[Step 1/4] Generating diverse self-play config..."

  # Step 1a: Generate benchmark config with diverse opponents
  python3 "$DIVERSE_SCRIPT" "$SELF_PLAY_BENCHMARK" \
    --games-per=5 \
    --ranker="$RANKER_BOOTSTRAP" 2>&1

  # Step 1b: Generate self-play wrapper config (with game plan support)
  python3 "$GI_AGENT_DIR/scripts/gen_selfplay_wrapper.py" \
    "$SELF_PLAY_BENCHMARK" "$SELF_PLAY_CONFIG" "$ITER_DIR" "$GAMES_MULTIPLIER" \
    --plans-dir "$PLANS_DIR" 2>&1

  GAME_COUNT=$((24 * 5 * GAMES_MULTIPLIER))

  echo ""
  echo "  Running self-play (~${GAME_COUNT} games, concurrency=${CONCURRENCY})..."
  STEP1_START=$(date +%s)

  bun run --smol src/learning/rl/cli/run-self-play-rl-smoke.ts \
    "$SELF_PLAY_CONFIG" 2>&1 | while IFS= read -r line; do
      if [[ "$line" == *"Self-play games:"* ]] || [[ "$line" == *"Inserted"* ]] || [[ "$line" == *"RL dataset"* ]]; then
        echo "  $line"
      fi
    done

  STEP1_DURATION=$(format_duration $(($(date +%s) - STEP1_START)))
  echo "  Step 1 complete (${STEP1_DURATION})."
else
  echo "[Step 1/4] Self-play data already exists, skipping."
fi

# ════════════════════════════════════════════════════
# Step 2: Streaming ranker
# ════════════════════════════════════════════════════
RANKER_ARTIFACT="$ART_DIR/local.ranker-artifact.json"
BUNDLE="$ART_DIR/local.bundle.json"

if [ ! -f "$RANKER_ARTIFACT" ]; then
  echo ""
  echo "[Step 2/4] Training streaming ranker..."
  STEP2_START=$(date +%s)

  RANKER_SHARDS_ARG=""
  if [ "$RANKER_MAX_SHARDS" -gt 0 ]; then
    RANKER_SHARDS_ARG="--max-shards $RANKER_MAX_SHARDS"
  fi

  pushd "$GI_ML_DIR" > /dev/null
  bun run --smol src/cli/run-build-ranker-streaming.ts \
    --manifest "$GI_AGENT_DIR/$MANIFEST" \
    --output-dir "$GI_AGENT_DIR/$ART_DIR" \
    --prefix local \
    --top-tags 32 \
    --top-candidate-slots 24 \
    $RANKER_SHARDS_ARG \
    --artifact-version "local_streaming"

  if [ $? -ne 0 ]; then
    echo "  ERROR: Ranker training failed."
    popd > /dev/null
    exit 1
  fi
  popd > /dev/null

  STEP2_DURATION=$(format_duration $(($(date +%s) - STEP2_START)))
  echo "  Step 2 complete (${STEP2_DURATION})."
else
  echo "[Step 2/4] Ranker artifact already exists, skipping."
fi

# ════════════════════════════════════════════════════
# Step 3: GBDT value model
# ════════════════════════════════════════════════════
GBDT_ARTIFACT="$ART_DIR/local.gbdt-value-artifact.json"

if [ ! -f "$GBDT_ARTIFACT" ]; then
  echo ""
  echo "[Step 3/4] Training GBDT value model (streaming)..."
  STEP3_START=$(date +%s)

  if [ ! -f "$LGBM_PYTHON" ]; then
    echo "  ERROR: LightGBM venv not found at $LGBM_PYTHON"
    echo "  Run: cd $GI_ML_DIR && python3 -m venv python/.lgbm-venv && python/.lgbm-venv/bin/pip install lightgbm numpy"
    exit 1
  fi

  "$LGBM_PYTHON" "$STREAM_TRAIN_PY" \
    --manifest "$MANIFEST" \
    --output-dir "$ART_DIR" \
    --prefix local \
    --estimators "$GBDT_ESTIMATORS" \
    --depth 5 \
    --lr 0.06 \
    --top-features "$GBDT_TOP_FEATURES" \
    --max-samples "$MAX_SAMPLES"

  if [ $? -ne 0 ]; then
    echo "  ERROR: GBDT training failed."
    exit 1
  fi

  STEP3_DURATION=$(format_duration $(($(date +%s) - STEP3_START)))
  echo "  Step 3 complete (${STEP3_DURATION})."
else
  echo "[Step 3/4] GBDT artifact already exists, skipping."
fi

# ════════════════════════════════════════════════════
# Step 4: Summary + optional benchmark
# ════════════════════════════════════════════════════
echo ""
echo "============================================================"
echo "  TRAINING COMPLETE"
echo "============================================================"
echo "  Ranker:     $RANKER_ARTIFACT"
echo "  GBDT Value: $GBDT_ARTIFACT"
echo "  Bundle:     $BUNDLE"
echo ""

TOTAL_DURATION=$(format_duration $(($(date +%s) - START_TIME)))
echo "  Total time: ${TOTAL_DURATION}"

if [ "$RUN_BENCHMARK" = "true" ] && [ -f "$RANKER_ARTIFACT" ] && [ -f "$GBDT_ARTIFACT" ]; then
  echo ""
  echo "[Step 4/4] Running quick benchmark..."
  STEP4_START=$(date +%s)

  # Generate quick benchmark config
  BENCH_CONFIG="$ITER_DIR/quick-benchmark.json"
  python3 << PYEOF
import json, os

training_config = json.load(open("$BENCHMARK_CONFIG"))
first_mirror = next((m for m in training_config["matchups"] if "mirror" in m.get("id", "")), training_config["matchups"][0])

config = {
    "version": "v6.3.0",
    "matchups": [{
        "id": "local-quick",
        "deck0Name": first_mirror.get("deck0Name", "deck0"),
        "deck1Name": first_mirror.get("deck1Name", "deck1"),
        "deck0": first_mirror["deck0"],
        "deck1": first_mirror["deck1"],
        "games": 4,
        "sideA": {
            "kind": "gi-ml-runtime",
            "rankerArtifactPath": os.path.abspath("$RANKER_ARTIFACT"),
            "valueArtifactPath": os.path.abspath("$GBDT_ARTIFACT"),
            "options": {"endTurnPenalty": 5, "temperature": 1.5, "qValueWeight": 1.5}
        },
        "sideB": {
            "kind": "baseline",
            "options": {"endTurnPenalty": 5, "temperature": 1.2, "adaptiveProfile": True}
        }
    }]
}

with open("$BENCH_CONFIG", "w") as f:
    json.dump(config, f, indent=2)
PYEOF

  bun run --smol src/evaluation/benchmark/cli/run-benchmark.ts \
    "$BENCH_CONFIG" \
    --output "$ITER_DIR/quick-benchmark-result.json" \
    --markdown "$ITER_DIR/quick-benchmark.md" \
    --concurrency 1 2>&1 | tail -10

  STEP4_DURATION=$(format_duration $(($(date +%s) - STEP4_START)))
  echo "  Step 4 complete (${STEP4_DURATION})."

  # Show result
  if [ -f "$ITER_DIR/quick-benchmark.md" ]; then
    echo ""
    echo "  Quick benchmark result:"
    cat "$ITER_DIR/quick-benchmark.md"
  fi
fi

echo ""
echo "============================================================"
echo "  All done."
echo "============================================================"
