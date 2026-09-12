#!/usr/bin/env bash
# Multi-Iteration Continuous Training Pipeline
# =============================================
#
# 连续运行多轮迭代训练，每轮自动使用上一轮最佳模型。
#
# Hardware target: i7-7700HQ, GTX1050, 16GB RAM
#
# Usage (从 packages/gi-agent/ 目录运行):
#   cd packages/gi-agent
#   bash ../../scripts/run-multi-iteration-training.sh
#
# ─────────────────────────────────────────────
# 可调参数说明（在下面变量赋值中修改）:
# ─────────────────────────────────────────────
#
# START_ITERATION    起始迭代编号（默认 18）
# END_ITERATION      结束迭代编号（默认 40）
# GAMES_MULTIPLIER   对局规模倍数（默认 3）
# SIDE_B_STRATEGY    sideB 策略: "diverse"/"baseline"/"mixed"
# CONCURRENCY        并行对局数（默认 2）
# BENCHMARK_PATH     对局配置文件路径
# OUTPUT_ROOT        输出根目录
# GBDT_ESTIMATORS    GBDT 树数量（默认 120）
# GBDT_DEPTH         GBDT 树深度（默认 5）
# GBDT_LR            GBDT 学习率（默认 0.06）
# GBDT_TOP_FEATURES  GBDT 特征数上限（默认 80）
# VALUE_BACKEND      Value model backend: "lgbm" or "ts-gbdt"
# MIN_SAMPLES        最小样本数（默认 500）
# PROMOTION_STRATEGY Promotion 策略: "mae" or "winrate"
# WIN_RATE_THRESHOLD 胜率阈值（默认 0.55）
# EVAL_GAMES_MULTIPLIER 评估对弈倍数（默认 1）
# SELF_PLAY_CHUNK_SIZE   分块 self-play 大小（0=不分块）
#
# 注意: 每轮迭代完成后自动清理中间文件

set -euo pipefail

# ════════════════════════════════════════════════════
# ▼▼▼ 调整参数 ▼▼▼
# ════════════════════════════════════════════════════
START_ITERATION="${START_ITERATION:-18}"
END_ITERATION="${END_ITERATION:-40}"
GAMES_MULTIPLIER="${GAMES_MULTIPLIER:-3}"
SIDE_B_STRATEGY="${SIDE_B_STRATEGY:-mixed}"
CONCURRENCY="${CONCURRENCY:-2}"
BENCHMARK_PATH="${BENCHMARK_PATH:-./benchmark.training-v3.json}"
OUTPUT_ROOT="${OUTPUT_ROOT:-./output/iter-training}"
GBDT_ESTIMATORS="${GBDT_ESTIMATORS:-120}"
GBDT_DEPTH="${GBDT_DEPTH:-5}"
GBDT_LR="${GBDT_LR:-0.06}"
GBDT_TOP_FEATURES="${GBDT_TOP_FEATURES:-80}"
VALUE_BACKEND="${VALUE_BACKEND:-lgbm}"
MIN_SAMPLES="${MIN_SAMPLES:-500}"
PROMOTION_STRATEGY="${PROMOTION_STRATEGY:-winrate}"
WIN_RATE_THRESHOLD="${WIN_RATE_THRESHOLD:-0.55}"
EVAL_GAMES_MULTIPLIER="${EVAL_GAMES_MULTIPLIER:-1}"
SELF_PLAY_CHUNK_SIZE="${SELF_PLAY_CHUNK_SIZE:-0}"
# RANKER_MODE: "full" (default, loads all data) or "streaming" (shard-by-shard)
RANKER_MODE="${RANKER_MODE:-full}"
# RANKER_MAX_SHARDS: max shards for streaming ranker (0=all)
RANKER_MAX_SHARDS="${RANKER_MAX_SHARDS:-50}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
START_TIME=$(date +%s)

# ============================================================
# Validation
# ============================================================

if [ "$START_ITERATION" -gt "$END_ITERATION" ]; then
    echo -e "\e[31mError: START_ITERATION ($START_ITERATION) > END_ITERATION ($END_ITERATION)\e[0m"
    exit 1
fi

STATE_FILE="$OUTPUT_ROOT/pipeline-state.json"

echo ""
echo -e "\e[36m$(printf '=%.0s' {1..70})\e[0m"
echo -e "\e[36m  MULTI-ITERATION TRAINING PIPELINE\e[0m"
echo -e "\e[36m$(printf '=%.0s' {1..70})\e[0m"
echo ""
ROUNDS=$((END_ITERATION - START_ITERATION + 1))
echo "  Iterations:        $START_ITERATION -> $END_ITERATION ($ROUNDS rounds)"
echo "  Games multiplier:  ${GAMES_MULTIPLIER}x"
echo "  SideB strategy:    $SIDE_B_STRATEGY"
if [ "$SIDE_B_STRATEGY" = "mixed" ]; then
    PRIMARY_GAMES=$((416 * GAMES_MULTIPLIER))
    BASELINE_GAMES=$((416 * 1))
    TOTAL_GAMES=$((PRIMARY_GAMES + BASELINE_GAMES))
    echo "  Est. games/iter:   ~$PRIMARY_GAMES (primary) + ~$BASELINE_GAMES (baseline) = ~$TOTAL_GAMES"
else
    EST_GAMES=$((416 * GAMES_MULTIPLIER))
    echo "  Est. games/iter:   ~$EST_GAMES"
fi
echo "  Concurrency:       $CONCURRENCY"
echo "  GBDT estimators:   $GBDT_ESTIMATORS"
echo "  GBDT depth:        $GBDT_DEPTH"
echo "  GBDT lr:           $GBDT_LR"
echo "  GBDT top features: $GBDT_TOP_FEATURES"
echo "  Value backend:     $VALUE_BACKEND"
echo "  Min samples:       $MIN_SAMPLES"
if [ "$PROMOTION_STRATEGY" = "winrate" ]; then
    echo "  Promotion:         $PROMOTION_STRATEGY (threshold=$WIN_RATE_THRESHOLD, evalGames=${EVAL_GAMES_MULTIPLIER}x)"
else
    echo "  Promotion:         $PROMOTION_STRATEGY"
fi
if [ "$SELF_PLAY_CHUNK_SIZE" -gt 0 ]; then
    echo "  Self-play chunks:  $SELF_PLAY_CHUNK_SIZE matchups/chunk"
fi
echo ""

# ============================================================
# Helper functions
# ============================================================

ensure_dir() {
    mkdir -p "$1"
}

format_duration() {
    local total_seconds=$1
    local hours=$((total_seconds / 3600))
    local minutes=$(( (total_seconds % 3600) / 60 ))
    if [ "$hours" -ge 1 ]; then
        printf "%.1fh" "$(echo "scale=1; $total_seconds / 3600" | bc)"
    else
        printf "%dmin" "$minutes"
    fi
}

get_best_artifacts() {
    if [ ! -f "$STATE_FILE" ]; then
        BEST_RANKER=""
        BEST_VALUE=""
        BEST_QVALUE=""
        BEST_ITERATION=""
        return
    fi

    BEST_RANKER=$(python3 -c "
import json, sys
try:
    with open('$STATE_FILE') as f:
        s = json.load(f)
    print(s.get('currentBestRankerPath', '') or '')
except: print('')
" 2>/dev/null || echo "")
    BEST_VALUE=$(python3 -c "
import json
try:
    with open('$STATE_FILE') as f:
        s = json.load(f)
    print(s.get('currentBestValuePath', '') or '')
except: print('')
" 2>/dev/null || echo "")
    BEST_QVALUE=$(python3 -c "
import json
try:
    with open('$STATE_FILE') as f:
        s = json.load(f)
    print(s.get('currentBestQValuePath', '') or '')
except: print('')
" 2>/dev/null || echo "")
    BEST_ITERATION=$(python3 -c "
import json
try:
    with open('$STATE_FILE') as f:
        s = json.load(f)
    print(s.get('currentBestIteration', '') or '')
except: print('')
" 2>/dev/null || echo "")

    # Validate files exist on disk
    if [ -n "$BEST_RANKER" ] && [ ! -f "$BEST_RANKER" ]; then
        echo -e "  \e[33mWARNING: Best ranker artifact not found on disk: $BEST_RANKER\e[0m"
        echo -e "  \e[33m           Falling back to baseline policy.\e[0m"
        BEST_RANKER=""
        BEST_VALUE=""
        BEST_QVALUE=""
    fi
    if [ -n "$BEST_VALUE" ] && [ ! -f "$BEST_VALUE" ]; then
        echo -e "  \e[33mWARNING: Best value artifact not found on disk: $BEST_VALUE\e[0m"
        BEST_VALUE=""
    fi
    if [ -n "$BEST_QVALUE" ] && [ ! -f "$BEST_QVALUE" ]; then
        echo -e "  \e[33mWARNING: Best Q-value artifact not found on disk: $BEST_QVALUE\e[0m"
        BEST_QVALUE=""
    fi
}

read_dataset_sample_count() {
    local path=$1
    if [ ! -f "$path" ]; then
        echo 0
        return
    fi

    # Read first 4KB to extract sample_count (large JSON optimization)
    local prefix
    prefix=$(head -c 4096 "$path" 2>/dev/null || echo "")
    local count
    count=$(echo "$prefix" | python3 -c "
import re, sys
text = sys.stdin.read()
m = re.search(r'\"sample_count\"\s*:\s*(\d+)', text)
if m:
    print(m.group(1))
else:
    print(0)
" 2>/dev/null || echo "0")

    if [ "$count" != "0" ] && [ -n "$count" ]; then
        echo "$count"
        return
    fi

    # Fallback for small files
    local file_size
    file_size=$(stat -f%z "$path" 2>/dev/null || stat -c%s "$path" 2>/dev/null || echo "0")
    if [ "$file_size" -lt 52428800 ]; then  # 50MB
        count=$(python3 -c "
import json, sys
try:
    with open('$path') as f:
        data = json.load(f)
    if 'sample_count' in data:
        print(data['sample_count'])
    elif 'samples' in data:
        print(len(data['samples']))
    else:
        print(0)
except:
    print(0)
" 2>/dev/null || echo "0")
        echo "$count"
        return
    fi

    local size_mb
    size_mb=$(echo "scale=1; $file_size / 1048576" | bc 2>/dev/null || echo "?")
    echo -e "  \e[33mWARNING: Could not extract sample_count from prefix (file: ${size_mb} MB)\e[0m" >&2
    echo 0
}

# JSON helper: create side config as JSON string
make_side_config() {
    local name=$1 kind=$2
    shift 2
    # Remaining args are key=value pairs for options
    local opts=""
    local extra=""
    for kv in "$@"; do
        local key="${kv%%=*}"
        local val="${kv#*=}"
        if [ "$key" = "rankerArtifactPath" ] || [ "$key" = "valueArtifactPath" ] || [ "$key" = "qValueArtifactPath" ]; then
            extra="$extra, \"$key\": \"$val\""
        elif [ "$val" = "true" ] || [ "$val" = "false" ]; then
            opts="$opts, \"$key\": $val"
        elif [[ "$val" =~ ^[0-9]+$ ]]; then
            opts="$opts, \"$key\": $val"
        elif [[ "$val" =~ ^[0-9]+\.[0-9]+$ ]]; then
            opts="$opts, \"$key\": $val"
        else
            opts="$opts, \"$key\": \"$val\""
        fi
    done
    echo "{\"name\": \"$name\", \"kind\": \"$kind\"${extra}${opts:+, \"options\": \{}${opts#*, }}"
}

# Use python3 for reliable JSON creation
json_set_field() {
    local json="$1"
    local key="$2"
    local value="$3"
    python3 -c "
import json, sys
data = json.loads('''$json''')
data['$key'] = $value
print(json.dumps(data))
" 2>/dev/null
}

# Store iteration results for final summary
declare -a ITER_RESULTS=()

# ============================================================
# Main loop
# ============================================================

for ((iter=START_ITERATION; iter<=END_ITERATION; iter++)); do
    ITER_START=$(date +%s)
    ITER_DIR=$(printf "%s/iter-%03d" "$OUTPUT_ROOT" "$iter")
    RL_DIR="$ITER_DIR/self-play-rl"
    ART_DIR="$ITER_DIR/artifacts"

    SELF_PLAY_CONFIG="$ITER_DIR/self-play-config.json"
    RL_DATASET_FILE="$ITER_DIR/rl-dataset.manifest.json"
    BUNDLE_FILE="$ART_DIR/iter${iter}.bundle.json"
    GBDT_VALUE_FILE="$ART_DIR/iter${iter}.gbdt-value-artifact.json"
    GBDT_EVAL_FILE="$ART_DIR/iter${iter}.gbdt-value-eval.json"
    GBDT_QVALUE_FILE="$ART_DIR/iter${iter}.gbdt-q-value-artifact.json"
    RANKER_FILE="$ART_DIR/iter${iter}.ranker-artifact.json"
    LINEAR_VALUE_FILE="$ART_DIR/iter${iter}.value-artifact.json"

    ensure_dir "$ITER_DIR"
    ensure_dir "$RL_DIR"
    ensure_dir "$ART_DIR"

    echo ""
    echo -e "\e[36m$(printf '=%.0s' {1..70})\e[0m"
    echo -e "\e[36m  ITERATION $iter / $END_ITERATION\e[0m"
    echo -e "\e[36m$(printf '=%.0s' {1..70})\e[0m"

    # ── Get best artifacts from previous iterations ──
    get_best_artifacts
    PREV_RANKER_PATH="$BEST_RANKER"
    PREV_VALUE_PATH="$BEST_VALUE"
    PREV_QVALUE_PATH="$BEST_QVALUE"

    if [ -n "$PREV_RANKER_PATH" ]; then
        echo -e "  \e[32mUsing best model from iter $BEST_ITERATION\e[0m"
    else
        echo -e "  \e[33mUsing baseline policy (no prior model)\e[0m"
    fi

    # ════════════════════════════════════════════════════
    # Step 1: Generate self-play config
    # ════════════════════════════════════════════════════

    echo -e "\n\e[33m[Step 1/$iter] Generating self-play config...\e[0m"

    if [ ! -f "$SELF_PLAY_CONFIG" ]; then
        # Build config using python3 for reliable JSON
        python3 << PYEOF
import json, os

start_iteration = $START_ITERATION
end_iteration = $END_ITERATION
games_multiplier = $GAMES_MULTIPLIER
side_b_strategy = "$SIDE_B_STRATEGY"
iter_num = $iter
benchmark_path = os.path.abspath("$BENCHMARK_PATH")
iter_dir = os.path.abspath("$ITER_DIR")

prev_ranker_path = "$PREV_RANKER_PATH"
prev_value_path = "$PREV_VALUE_PATH"
prev_qvalue_path = "$PREV_QVALUE_PATH"

# Build sideA config
if prev_ranker_path:
    sideA_config = {
        "name": f"trained-iter{iter_num}",
        "kind": "gi-ml-runtime",
        "rankerArtifactPath": os.path.abspath(prev_ranker_path),
        "options": {"endTurnPenalty": 5, "temperature": 1.5, "qValueWeight": 1.5}
    }
    if prev_value_path:
        sideA_config["valueArtifactPath"] = os.path.abspath(prev_value_path)
    if prev_qvalue_path:
        sideA_config["qValueArtifactPath"] = os.path.abspath(prev_qvalue_path)
    else:
        # Fallback: infer from value artifact path
        inferred_qvalue = prev_value_path.replace(".gbdt-value-artifact.json", ".gbdt-q-value-artifact.json")
        if inferred_qvalue != prev_value_path and os.path.exists(inferred_qvalue):
            sideA_config["qValueArtifactPath"] = os.path.abspath(inferred_qvalue)
else:
    sideA_config = {
        "name": "baseline",
        "kind": "baseline",
        "options": {"endTurnPenalty": 5, "temperature": 1.5}
    }

# Build sideB-diverse config
if prev_ranker_path:
    side_b_diverse_config = {
        "name": "opponent-diverse",
        "kind": "gi-ml-runtime",
        "rankerArtifactPath": os.path.abspath(prev_ranker_path),
        "options": {"endTurnPenalty": 5, "temperature": 2.5}
    }
    if prev_value_path:
        side_b_diverse_config["valueArtifactPath"] = os.path.abspath(prev_value_path)
        side_b_diverse_config["options"]["qValueWeight"] = 1.0
else:
    side_b_diverse_config = {
        "name": "opponent-diverse",
        "kind": "baseline",
        "options": {"endTurnPenalty": 5, "temperature": 2.0}
    }

side_b_baseline_config = {
    "name": "opponent-heuristic",
    "kind": "baseline",
    "options": {"endTurnPenalty": 5, "temperature": 1.2, "adaptiveProfile": True}
}

# Select sideB based on strategy
if side_b_strategy == "baseline":
    side_b_config = side_b_baseline_config
elif side_b_strategy == "diverse":
    side_b_config = side_b_diverse_config
else:  # "mixed"
    side_b_config = side_b_diverse_config

config = {
    "benchmarkPath": benchmark_path,
    "gamesMultiplier": games_multiplier,
    "rlCapture": {
        "directory": os.path.join(iter_dir, "self-play-rl"),
        "modelVersion": f"iter-{iter_num}",
        "viewKind": "policy_public",
        "gameVersion": "v6.3.0",
        "cardPoolVersion": "v6.3.0",
        "rulesetVersion": "default",
        "contractVersion": "obs.v1"
    },
    "replayLogCapture": {
        "directory": os.path.join(iter_dir, "replay-logs"),
        "maxGamesPerMatchup": 2
    },
    "dataset": {
        "manifestPath": os.path.join(iter_dir, "rl-dataset.manifest.json"),
        "shardDir": os.path.join(iter_dir, "rl-dataset.shards"),
        "maxSamplesPerShard": 2000,
        "includeSides": [0, 1],
        "requireChosenCandidate": True
    },
    "sideA": sideA_config,
    "sideB": side_b_config,
    "outputPath": os.path.join(iter_dir, "self-play-result.json")
}

with open("$SELF_PLAY_CONFIG", "w", encoding="utf-8") as f:
    json.dump(config, f, indent=2, ensure_ascii=False)

print(f"  Config written: $SELF_PLAY_CONFIG")
print(f"  SideA: {sideA_config['name']} (kind={sideA_config['kind']})")
print(f"  SideB: {side_b_config['name']} (kind={side_b_config['kind']}, strategy={side_b_strategy})")

# For "mixed" strategy, also create secondary baseline config
if side_b_strategy == "mixed":
    secondary_config = {
        "benchmarkPath": benchmark_path,
        "gamesMultiplier": 1,
        "rlCapture": {
            "directory": os.path.join(iter_dir, "self-play-rl-baseline"),
            "modelVersion": f"iter-{iter_num}-baseline",
            "viewKind": "policy_public",
            "gameVersion": "v6.3.0",
            "cardPoolVersion": "v6.3.0",
            "rulesetVersion": "default",
            "contractVersion": "obs.v1"
        },
        "replayLogCapture": {
            "directory": os.path.join(iter_dir, "replay-logs-baseline"),
            "maxGamesPerMatchup": 1
        },
        "dataset": {
            "manifestPath": os.path.join(iter_dir, "rl-dataset-baseline.manifest.json"),
            "shardDir": os.path.join(iter_dir, "rl-dataset-baseline.shards"),
            "maxSamplesPerShard": 2000,
            "includeSides": [0, 1],
            "requireChosenCandidate": True
        },
        "sideA": sideA_config,
        "sideB": side_b_baseline_config,
        "outputPath": os.path.join(iter_dir, "self-play-result-baseline.json")
    }
    secondary_path = os.path.join(iter_dir, "self-play-config-baseline.json")
    with open(secondary_path, "w", encoding="utf-8") as f:
        json.dump(secondary_config, f, indent=2, ensure_ascii=False)
    print(f"  Secondary config written: {secondary_path} (baseline opponent)")
PYEOF

    else
        echo "  Config already exists, skipping."
    fi

    # ════════════════════════════════════════════════════
    # Step 2: Run self-play
    # ════════════════════════════════════════════════════

    echo -e "\n\e[33m[Step 2/$iter] Running self-play...\e[0m"

    if [ ! -f "$RL_DATASET_FILE" ]; then
        GAME_COUNT=$((416 * GAMES_MULTIPLIER))
        EST_MINUTES=$(python3 -c "print(int($GAME_COUNT * 0.4))")
        EST_DURATION=$(format_duration $((EST_MINUTES * 60)))
        echo -e "  \e[35mStarting self-play (~${GAME_COUNT} games, est. ${EST_DURATION})...\e[0m"
        if [ -n "$PREV_RANKER_PATH" ]; then
            echo "  SideA: gi-ml-runtime (iter $BEST_ITERATION)"
        else
            echo "  SideA: baseline"
        fi
        echo "  SideB: $SIDE_B_STRATEGY"
        echo -e "  \e[36mNOTE: chooseActive is RANDOM during training for character diversity\e[0m"

        if [ "$SELF_PLAY_CHUNK_SIZE" -gt 0 ]; then
            echo ""
            echo -e "  \e[36mRunning in CHUNKED mode ($SELF_PLAY_CHUNK_SIZE matchups/chunk) for memory efficiency\e[0m"
        fi

        # Primary self-play
        if [ "$SELF_PLAY_CHUNK_SIZE" -gt 0 ]; then
            CHUNKED_SCRIPT="$SCRIPT_DIR/run-self-play-chunked.ts"
            if [ -f "$CHUNKED_SCRIPT" ]; then
                bun run "$CHUNKED_SCRIPT" "$SELF_PLAY_CONFIG" --chunk-size "$SELF_PLAY_CHUNK_SIZE" --cwd "$(pwd)"
            else
                echo -e "  \e[33mWARNING: Chunked runner not found, falling back to standard mode\e[0m"
                bun run --smol src/learning/rl/cli/run-self-play-rl-smoke.ts "$SELF_PLAY_CONFIG"
            fi
        else
            bun run --smol src/learning/rl/cli/run-self-play-rl-smoke.ts "$SELF_PLAY_CONFIG"
        fi

        if [ $? -ne 0 ]; then
            echo -e "  \e[31mSelf-play failed\e[0m"
            exit 1
        fi

        if [ ! -f "$RL_DATASET_FILE" ]; then
            echo -e "  \e[31mWarning: RL dataset not found after self-play.\e[0m"
            exit 1
        fi
        echo "  Primary self-play complete. Dataset: $RL_DATASET_FILE"

        # Secondary self-play for "mixed" strategy
        if [ "$SIDE_B_STRATEGY" = "mixed" ]; then
            SECONDARY_CONFIG_PATH="$ITER_DIR/self-play-config-baseline.json"
            SECONDARY_DATASET_PATH="$ITER_DIR/rl-dataset-baseline.manifest.json"

            if [ -f "$SECONDARY_CONFIG_PATH" ] && [ ! -f "$SECONDARY_DATASET_PATH" ]; then
                SECONDARY_GAMES=$((416 * 1))
                echo -e "\n  \e[35mStarting secondary self-play vs baseline (~${SECONDARY_GAMES} games)...\e[0m"
                echo -e "  \e[35mSideB: baseline (heuristic opponent for data diversity)\e[0m"

                bun run --smol src/learning/rl/cli/run-self-play-rl-smoke.ts "$SECONDARY_CONFIG_PATH"

                if [ $? -ne 0 ]; then
                    echo -e "  \e[33mSecondary self-play failed (non-fatal, continuing with primary data).\e[0m"
                elif [ -f "$SECONDARY_DATASET_PATH" ]; then
                    echo "  Secondary self-play complete. Merging shard datasets..."

                    PRIMARY_SHARD_DIR="$ITER_DIR/rl-dataset.shards"
                    SECONDARY_SHARD_DIR="$ITER_DIR/rl-dataset-baseline.shards"
                    MERGE_SCRIPT="$SCRIPT_DIR/merge-rl-manifests.ts"
                    ABS_PRIMARY_MANIFEST=$(python3 -c "import os; print(os.path.abspath('$RL_DATASET_FILE'))")
                    ABS_SECONDARY_MANIFEST=$(python3 -c "import os; print(os.path.abspath('$SECONDARY_DATASET_PATH'))")

                    if [ -f "$MERGE_SCRIPT" ] && [ -d "$PRIMARY_SHARD_DIR" ] && [ -d "$SECONDARY_SHARD_DIR" ]; then
                        bun run "$MERGE_SCRIPT" "$ABS_PRIMARY_MANIFEST" "$ABS_SECONDARY_MANIFEST"
                        if [ $? -eq 0 ]; then
                            echo -e "  \e[32mDatasets merged successfully.\e[0m"
                        else
                            echo -e "  \e[33mMerge failed (non-fatal). Keeping primary dataset only.\e[0m"
                        fi
                    else
                        echo -e "  \e[33mMerge script or shard dirs not found. Keeping primary dataset only.\e[0m"
                    fi
                fi
            fi
        fi

        echo -e "  \e[32mSelf-play complete.\e[0m"
    else
        echo "  RL dataset already exists, skipping."
    fi

    # ── Data quality check ──
    echo -e "\n  \e[33m[Data Quality Check]\e[0m"
    SAMPLE_COUNT=$(read_dataset_sample_count "$RL_DATASET_FILE")
    echo "  Samples: $SAMPLE_COUNT (minimum: $MIN_SAMPLES)"

    if [ "$SAMPLE_COUNT" -lt "$MIN_SAMPLES" ]; then
        echo -e "  \e[31mWARNING: Insufficient samples ($SAMPLE_COUNT < $MIN_SAMPLES). Skipping this iteration.\e[0m"
        ITER_DURATION=$(( $(date +%s) - ITER_START ))
        DUR_STR=$(format_duration $ITER_DURATION)
        ITER_RESULTS+=("$iter|SKIP|$SAMPLE_COUNT|0|0|$DUR_STR")
        continue
    fi

    if [ "$SAMPLE_COUNT" -lt 1000 ]; then
        echo -e "  \e[33mWARNING: Low sample count ($SAMPLE_COUNT). Training may be unreliable.\e[0m"
    else
        echo -e "  \e[32mData quality: OK ($SAMPLE_COUNT samples)\e[0m"
    fi

    # ════════════════════════════════════════════════════
    # Step 3: Train ranker + linear value
    # ════════════════════════════════════════════════════

    echo -e "\n\e[33m[Step 3/$iter] Training ranker + linear value...\e[0m"

    if [ ! -f "$BUNDLE_FILE" ]; then
        ABS_RL_DATASET=$(python3 -c "import os; print(os.path.abspath('$RL_DATASET_FILE'))")
        ABS_ART_DIR=$(python3 -c "import os; print(os.path.abspath('$ART_DIR'))")

        if [ "$RANKER_MODE" = "streaming" ]; then
            echo -e "  \\e[36mUsing streaming ranker (shard-by-shard, low memory)\\e[0m"
            RANKER_SHARDS_ARG=""
            if [ "$RANKER_MAX_SHARDS" -gt 0 ]; then
                RANKER_SHARDS_ARG="--max-shards $RANKER_MAX_SHARDS"
            fi
            pushd ../gi-ml > /dev/null
            bun run --smol ./src/cli/run-build-ranker-streaming.ts \
                --manifest "$ABS_RL_DATASET" \
                --output-dir "$ABS_ART_DIR" \
                --prefix "iter${iter}" \
                --top-tags 32 \
                --top-candidate-slots 24 \
                $RANKER_SHARDS_ARG \
                --artifact-version "iter${iter}_streaming"
            popd > /dev/null
        else
            pushd ../gi-ml > /dev/null
            bun run ./src/cli/run-build-rl-warm-start-bundle.ts \
                --input "$ABS_RL_DATASET" \
                --output-dir "$ABS_ART_DIR" \
                --prefix "iter${iter}" \
                --top-tags 32 \
                --top-candidate-slots 24 \
                --top-features 32
            popd > /dev/null
        fi

        if [ $? -ne 0 ]; then
            echo -e "  \\e[31mWarm-start bundle failed.\\e[0m"
            exit 1
        fi

        echo "  Bundle complete."
    else
        echo "  Bundle already exists, skipping."
    fi

    # ════════════════════════════════════════════════════
    # Step 4: Train GBDT value model
    # ════════════════════════════════════════════════════

    echo -e "\n\e[33m[Step 4/$iter] Training GBDT value model ($VALUE_BACKEND)...\e[0m"

    if [ ! -f "$GBDT_VALUE_FILE" ]; then
        ABS_RL_DATASET=$(python3 -c "import os; print(os.path.abspath('$RL_DATASET_FILE'))")
        ABS_ART_DIR=$(python3 -c "import os; print(os.path.abspath('$ART_DIR'))")

        pushd ../gi-ml > /dev/null
        if [ "$VALUE_BACKEND" = "lgbm" ]; then
            bun run ./src/cli/run-build-lgbm-value.ts \
                --input "$ABS_RL_DATASET" \
                --output-dir "$ABS_ART_DIR" \
                --prefix "iter${iter}" \
                --estimators "$GBDT_ESTIMATORS" \
                --depth "$GBDT_DEPTH" \
                --lr "$GBDT_LR" \
                --top-features "$GBDT_TOP_FEATURES"
        else
            bun run ./src/cli/run-build-gbdt-value.ts \
                --input "$ABS_RL_DATASET" \
                --output-dir "$ABS_ART_DIR" \
                --prefix "iter${iter}" \
                --estimators "$GBDT_ESTIMATORS" \
                --depth "$GBDT_DEPTH" \
                --lr "$GBDT_LR" \
                --top-features "$GBDT_TOP_FEATURES"
        fi

        if [ $? -ne 0 ]; then
            echo -e "  \e[31mGBDT training failed.\e[0m"
            popd > /dev/null
            exit 1
        fi

        popd > /dev/null
        echo "  GBDT value training complete."
    else
        echo "  GBDT value artifact already exists, skipping."
    fi

    # ════════════════════════════════════════════════════
    # Step 4.5: Train Q-value model
    # ════════════════════════════════════════════════════

    echo -e "\n\e[33m[Step 4.5/$iter] Training GBDT Q-value model...\e[0m"

    if [ ! -f "$GBDT_QVALUE_FILE" ]; then
        ABS_RL_DATASET=$(python3 -c "import os; print(os.path.abspath('$RL_DATASET_FILE'))")
        ABS_ART_DIR=$(python3 -c "import os; print(os.path.abspath('$ART_DIR'))")

        pushd ../gi-ml > /dev/null
        bun run ./src/cli/run-build-lgbm-q-value.ts \
            --input "$ABS_RL_DATASET" \
            --output-dir "$ABS_ART_DIR" \
            --prefix "iter${iter}" \
            --estimators "$GBDT_ESTIMATORS" \
            --depth "$GBDT_DEPTH" \
            --lr "$GBDT_LR" \
            --top-features "$GBDT_TOP_FEATURES"

        if [ $? -ne 0 ]; then
            echo -e "  \e[33mQ-value training failed (non-fatal, continuing).\e[0m"
        else
            echo "  Q-value training complete."
        fi

        popd > /dev/null
    else
        echo "  Q-value artifact already exists, skipping."
    fi

    # ════════════════════════════════════════════════════
    # Step 5: Update pipeline state + promotion
    # ════════════════════════════════════════════════════

    echo -e "\n\e[33m[Step 5/$iter] Updating pipeline state...\e[0m"

    RANKER_PAIRWISE=""
    VALUE_MAE=""
    VALUE_RMSE=""

    if [ -f "$BUNDLE_FILE" ]; then
        RANKER_PAIRWISE=$(python3 -c "
import json
with open('$BUNDLE_FILE') as f:
    data = json.load(f)
print(data.get('metrics', {}).get('ranking', {}).get('pairwise_support_rate', ''))
" 2>/dev/null || echo "")
    fi

    if [ -f "$GBDT_EVAL_FILE" ]; then
        VALUE_MAE=$(python3 -c "
import json
with open('$GBDT_EVAL_FILE') as f:
    data = json.load(f)
print(data.get('mae', ''))
" 2>/dev/null || echo "")
        VALUE_RMSE=$(python3 -c "
import json
with open('$GBDT_EVAL_FILE') as f:
    data = json.load(f)
print(data.get('rmse', ''))
" 2>/dev/null || echo "")
    fi

    # Promotion logic
    PROMOTED=false
    MIN_PAIRWISE=0.55
    MIN_MAE_IMPROVEMENT=0.002

    if [ "$PROMOTION_STRATEGY" = "winrate" ]; then
        echo -e "  \e[36mPromotion strategy: WINRATE (new vs current best)\e[0m"

        if [ -z "$PREV_RANKER_PATH" ]; then
            # No previous model — promote if ranker is reasonable
            if [ -n "$RANKER_PAIRWISE" ]; then
                PW_OK=$(python3 -c "print('true' if float('$RANKER_PAIRWISE') >= $MIN_PAIRWISE else 'false')")
                if [ "$PW_OK" = "true" ]; then
                    PROMOTED=true
                    echo -e "  \e[32mFirst model with pairwise $RANKER_PAIRWISE >= $MIN_PAIRWISE -> PROMOTE\e[0m"
                fi
            fi
        else
            # Run evaluation: new model vs current best
            EVAL_CONFIG_PATH="$ITER_DIR/eval-winrate-config.json"
            EVAL_RESULT_PATH="$ITER_DIR/eval-winrate-result.json"

            PYTHON_EVAL_INPUT=$(python3 -c "
import json, os

# sideA = candidate (newly trained model)
eval_side_a = {
    'name': 'candidate-iter${iter}',
    'kind': 'gi-ml-runtime',
    'rankerArtifactPath': os.path.abspath('$RANKER_FILE'),
    'options': {'endTurnPenalty': 5, 'temperature': 1.0, 'qValueWeight': 1.0}
}
gbdt_value_file = '$GBDT_VALUE_FILE'
linear_value_file = '$LINEAR_VALUE_FILE'
if os.path.exists(gbdt_value_file):
    eval_side_a['valueArtifactPath'] = os.path.abspath(gbdt_value_file)
elif os.path.exists(linear_value_file):
    eval_side_a['valueArtifactPath'] = os.path.abspath(linear_value_file)
gbdt_qvalue_file = '$GBDT_QVALUE_FILE'
if os.path.exists(gbdt_qvalue_file):
    eval_side_a['qValueArtifactPath'] = os.path.abspath(gbdt_qvalue_file)

# sideB = current best model
eval_side_b = {
    'name': 'previous-best',
    'kind': 'gi-ml-runtime',
    'rankerArtifactPath': os.path.abspath('$PREV_RANKER_PATH'),
    'options': {'endTurnPenalty': 5, 'temperature': 1.0, 'qValueWeight': 1.0}
}
prev_value = '$PREV_VALUE_PATH'
if prev_value and os.path.exists(prev_value):
    eval_side_b['valueArtifactPath'] = os.path.abspath(prev_value)
prev_qvalue = '$PREV_QVALUE_PATH'
if prev_qvalue and os.path.exists(prev_qvalue):
    eval_side_b['qValueArtifactPath'] = os.path.abspath(prev_qvalue)

# Read benchmark to get deck pairs
with open(os.path.abspath('$BENCHMARK_PATH')) as f:
    benchmark_data = json.load(f)

eval_matchups = []
for mu in benchmark_data['matchups']:
    eval_matchups.append({
        'id': mu['id'],
        'deck0': mu['deck0'],
        'deck1': mu['deck1'],
        'games': int(round(mu['games'] * $EVAL_GAMES_MULTIPLIER)),
        'sideA': eval_side_a,
        'sideB': eval_side_b
    })

eval_config = {
    'version': benchmark_data.get('version'),
    'matchups': eval_matchups
}

with open('$EVAL_CONFIG_PATH', 'w', encoding='utf-8') as f:
    json.dump(eval_config, f, indent=2, ensure_ascii=False)

print('done')
" 2>/dev/null)

            EVAL_GAME_COUNT=$(python3 -c "
import json
with open('$EVAL_CONFIG_PATH') as f:
    data = json.load(f)
print(sum(m['games'] for m in data['matchups']))
" 2>/dev/null || echo "0")

            echo -e "  \e[35mRunning win-rate evaluation (~${EVAL_GAME_COUNT} games)...\e[0m"
            pushd ../gi-agent > /dev/null
            bun run --smol src/evaluation/benchmark/cli/run-benchmark.ts "$EVAL_CONFIG_PATH" --output "$EVAL_RESULT_PATH"
            popd > /dev/null

            if [ -f "$EVAL_RESULT_PATH" ]; then
                # Parse eval result
                EVAL_RESULT=$(python3 -c "
import json
with open('$EVAL_RESULT_PATH') as f:
    data = json.load(f)
total_eval = 0
wins_eval = 0
for row in data['result']['results']:
    total_eval += row['batch']['total']
    wins_eval += row['batch']['winsP0']  # sideA = candidate
if total_eval > 0:
    win_rate = wins_eval / total_eval
else:
    win_rate = 0
print(f'{win_rate:.6f}|{wins_eval}|{total_eval}')
" 2>/dev/null || echo "0|0|0")

                WIN_RATE=$(echo "$EVAL_RESULT" | cut -d'|' -f1)
                WINS_EVAL=$(echo "$EVAL_RESULT" | cut -d'|' -f2)
                TOTAL_EVAL=$(echo "$EVAL_RESULT" | cut -d'|' -f3)
                WIN_RATE_PCT=$(python3 -c "print(f'{float($WIN_RATE)*100:.1f}')" 2>/dev/null || echo "0")
                echo -e "  \e[36mWin-rate: ${WIN_RATE_PCT}% (${WINS_EVAL} / ${TOTAL_EVAL} games)\e[0m"

                # Check promotion
                PROMOTE_CHECK=$(python3 -c "
wr = float('$WIN_RATE')
pw = float('$RANKER_PAIRWISE') if '$RANKER_PAIRWISE' else 0.0
threshold = float('$WIN_RATE_THRESHOLD')
min_pw = float('$MIN_PAIRWISE')
print('true' if wr >= threshold and pw >= min_pw else 'false')
" 2>/dev/null || echo "false")

                if [ "$PROMOTE_CHECK" = "true" ]; then
                    PROMOTED=true
                    echo -e "  \e[32mWin-rate ${WIN_RATE_PCT}% >= $(python3 -c "print(f'{float($WIN_RATE_THRESHOLD)*100:.0f}%')") -> PROMOTE\e[0m"
                else
                    FAIL_REASON=$(python3 -c "
wr = float('$WIN_RATE')
threshold = float('$WIN_RATE_THRESHOLD')
pw = float('$RANKER_PAIRWISE') if '$RANKER_PAIRWISE' else 0.0
min_pw = float('$MIN_PAIRWISE')
if wr < threshold:
    print(f'win-rate {wr*100:.1f}% < {threshold*100:.0f}%')
else:
    print(f'pairwise {pw} < {min_pw}')
" 2>/dev/null || echo "unknown")
                    echo -e "  \e[33mNOT promoted: $FAIL_REASON\e[0m"
                fi
            else
                echo -e "  \e[33mWARNING: Eval result not found, falling back to MAE comparison\e[0m"
                # Fallback to MAE comparison
                if [ -f "$STATE_FILE" ]; then
                    PREV_BEST_MAE=$(python3 -c "
import json
with open('$STATE_FILE') as f:
    state = json.load(f)
promoted = [it for it in state.get('iterations', []) if it.get('promoted')]
if promoted:
    mae = promoted[-1].get('valueMetrics', {}).get('mae')
    print(mae if mae is not None else '')
else:
    print('')
" 2>/dev/null || echo "")
                    if [ -n "$PREV_BEST_MAE" ] && [ -n "$VALUE_MAE" ]; then
                        IMPROVEMENT=$(python3 -c "
improvement = float('$PREV_BEST_MAE') - float('$VALUE_MAE')
pw = float('$RANKER_PAIRWISE') if '$RANKER_PAIRWISE' else 0.0
min_pw = float('$MIN_PAIRWISE')
min_imp = float('$MIN_MAE_IMPROVEMENT')
print('true' if improvement >= min_imp and pw >= min_pw else 'false')
" 2>/dev/null || echo "false")
                        if [ "$IMPROVEMENT" = "true" ]; then
                            PROMOTED=true
                        fi
                    else
                        PROMOTED=true
                    fi
                fi
            fi

            # Clean up eval config/result
            rm -f "$EVAL_CONFIG_PATH" "$EVAL_RESULT_PATH"
        fi
    else
        # Legacy MAE-based promotion
        echo -e "  \e[36mPromotion strategy: MAE comparison (legacy)\e[0m"

        if [ -z "$PREV_RANKER_PATH" ]; then
            if [ -n "$RANKER_PAIRWISE" ]; then
                PW_OK=$(python3 -c "print('true' if float('$RANKER_PAIRWISE') >= $MIN_PAIRWISE else 'false')")
                if [ "$PW_OK" = "true" ]; then
                    PROMOTED=true
                fi
            fi
        else
            if [ -f "$STATE_FILE" ]; then
                PREV_BEST_MAE=$(python3 -c "
import json
with open('$STATE_FILE') as f:
    state = json.load(f)
promoted = [it for it in state.get('iterations', []) if it.get('promoted')]
if promoted:
    mae = promoted[-1].get('valueMetrics', {}).get('mae')
    print(mae if mae is not None else '')
else:
    print('')
" 2>/dev/null || echo "")
                if [ -n "$PREV_BEST_MAE" ] && [ -n "$VALUE_MAE" ]; then
                    IMPROVEMENT=$(python3 -c "
improvement = float('$PREV_BEST_MAE') - float('$VALUE_MAE')
pw = float('$RANKER_PAIRWISE') if '$RANKER_PAIRWISE' else 0.0
min_pw = float('$MIN_PAIRWISE')
min_imp = float('$MIN_MAE_IMPROVEMENT')
print('true' if improvement >= min_imp and pw >= min_pw else 'false')
" 2>/dev/null || echo "false")
                    if [ "$IMPROVEMENT" = "true" ]; then
                        PROMOTED=true
                    fi
                else
                    PROMOTED=true
                fi
            else
                PROMOTED=true
            fi
        fi
    fi

    BEST_VALUE_PATH="$GBDT_VALUE_FILE"
    if [ ! -f "$GBDT_VALUE_FILE" ]; then
        BEST_VALUE_PATH="$LINEAR_VALUE_FILE"
    fi
    if [ ! -f "$BEST_VALUE_PATH" ] && [ -n "$PREV_VALUE_PATH" ] && [ -f "$PREV_VALUE_PATH" ]; then
        BEST_VALUE_PATH="$PREV_VALUE_PATH"
    fi

    BEST_QVALUE_PATH=""
    if [ -f "$GBDT_QVALUE_FILE" ]; then
        BEST_QVALUE_PATH=$(python3 -c "import os; print(os.path.abspath('$GBDT_QVALUE_FILE'))")
    fi

    ABS_RANKER_FILE=$(python3 -c "import os; print(os.path.abspath('$RANKER_FILE'))")
    ABS_BEST_VALUE=$(python3 -c "import os; print(os.path.abspath('$BEST_VALUE_PATH'))" 2>/dev/null || echo "")

    # Update pipeline state using python3
    python3 << PYEOF
import json, os, datetime

state_file = "$STATE_FILE"
ranker_path = "$ABS_RANKER_FILE"
value_path = "$ABS_BEST_VALUE"
qvalue_path = "$BEST_QVALUE_PATH"
promoted = $PROMOTED

iter_result = {
    "iteration": $iter,
    "rankerMetrics": {"pairwiseSupport": float("$RANKER_PAIRWISE") if "$RANKER_PAIRWISE" else None},
    "valueMetrics": {
        "mae": float("$VALUE_MAE") if "$VALUE_MAE" else None,
        "rmse": float("$VALUE_RMSE") if "$VALUE_RMSE" else None
    },
    "promoted": promoted,
    "artifactPaths": {
        "ranker": ranker_path,
        "value": value_path,
        "qvalue": qvalue_path
    },
    "promotionStrategy": "$PROMOTION_STRATEGY"
}

if os.path.exists(state_file):
    with open(state_file) as f:
        state = json.load(f)
else:
    state = {
        "currentBestIteration": None,
        "currentBestRankerPath": None,
        "currentBestValuePath": None,
        "currentBestQValuePath": None,
        "iterations": [],
        "startedAt": datetime.datetime.now().isoformat()
    }

if "iterations" not in state:
    state["iterations"] = []
state["iterations"].append(iter_result)

if promoted:
    state["currentBestIteration"] = $iter
    state["currentBestRankerPath"] = ranker_path
    state["currentBestValuePath"] = value_path
    state["currentBestQValuePath"] = qvalue_path

state["lastUpdatedAt"] = datetime.datetime.now().isoformat()

with open(state_file, "w", encoding="utf-8") as f:
    json.dump(state, f, indent=2, ensure_ascii=False)
PYEOF

    # ── Iteration summary ──
    ITER_DURATION=$(( $(date +%s) - ITER_START ))
    DUR_STR=$(format_duration $ITER_DURATION)

    echo ""
    echo "$(printf -- '-%.0s' {1..50})"
    echo "  Iter $iter complete in $DUR_STR"
    echo "  Ranker pairwise: $RANKER_PAIRWISE"
    echo "  Value MAE:       $VALUE_MAE"
    echo "  Value RMSE:      $VALUE_RMSE"
    echo "  Samples:         $SAMPLE_COUNT"

    if [ "$PROMOTED" = true ]; then
        echo -e "  \e[32mStatus: PROMOTED ✓\e[0m"
        STATUS="PROMOTE"
    else
        echo -e "  \e[33mStatus: NOT PROMOTED (keeping previous best)\e[0m"
        STATUS="REJECT"
    fi

    ITER_RESULTS+=("$iter|$STATUS|$RANKER_PAIRWISE|$VALUE_MAE|$VALUE_RMSE|$SAMPLE_COUNT|$DUR_STR")

    # ════════════════════════════════════════════════════
    # Step 6: Cleanup intermediate files
    # ════════════════════════════════════════════════════

    echo -e "\n\e[33m[Step 6/$iter] Cleaning up intermediate files...\e[0m"

    CLEANED_MB=0

    # Helper: remove a path and track freed space
    remove_tracked_item() {
        local path=$1
        if [ -e "$path" ]; then
            local size=0
            if [ -d "$path" ]; then
                size=$(du -sb "$path" 2>/dev/null | cut -f1 || echo "0")
                rm -rf "$path"
            else
                size=$(stat -c%s "$path" 2>/dev/null || stat -f%z "$path" 2>/dev/null || echo "0")
                rm -f "$path"
            fi
            local mb=$(python3 -c "print(round($size / 1048576, 1))" 2>/dev/null || echo "0")
            CLEANED_MB=$(python3 -c "print(round($CLEANED_MB + $mb, 1))" 2>/dev/null || echo "$CLEANED_MB")
        fi
    }

    # Self-play raw captures
    remove_tracked_item "$ITER_DIR/self-play-rl"
    remove_tracked_item "$ITER_DIR/self-play-rl-baseline"

    # Replay logs
    remove_tracked_item "$ITER_DIR/replay-logs"
    remove_tracked_item "$ITER_DIR/replay-logs-baseline"

    # RL dataset files
    remove_tracked_item "$ITER_DIR/rl-dataset.json"
    remove_tracked_item "$ITER_DIR/rl-dataset.manifest.json"
    remove_tracked_item "$ITER_DIR/rl-dataset.shards"
    remove_tracked_item "$ITER_DIR/rl-dataset-baseline.json"
    remove_tracked_item "$ITER_DIR/rl-dataset-baseline.manifest.json"
    remove_tracked_item "$ITER_DIR/rl-dataset-baseline.shards"

    # Artifact intermediate files
    ARTIFACT_DIR="$ITER_DIR/artifacts"
    if [ -d "$ARTIFACT_DIR" ]; then
        # Read current best paths from state
        CURRENT_BEST_RANKER=$(python3 -c "
import json
with open('$STATE_FILE') as f:
    s = json.load(f)
print(s.get('currentBestRankerPath', ''))
" 2>/dev/null || echo "")
        CURRENT_BEST_VALUE=$(python3 -c "
import json
with open('$STATE_FILE') as f:
    s = json.load(f)
print(s.get('currentBestValuePath', ''))
" 2>/dev/null || echo "")
        CURRENT_BEST_QVALUE=$(python3 -c "
import json
with open('$STATE_FILE') as f:
    s = json.load(f)
print(s.get('currentBestQValuePath', ''))
" 2>/dev/null || echo "")

        for f in "$ARTIFACT_DIR"/*-dataset.json "$ARTIFACT_DIR"/*-eval.json "$ARTIFACT_DIR"/*bundle.json "$ARTIFACT_DIR"/*value-artifact.json "$ARTIFACT_DIR"/*ranking-dataset.json; do
            # Skip if glob didn't expand
            [ -e "$f" ] || continue
            # Don't delete current best artifacts
            if [ "$(python3 -c "import os; print(os.path.abspath('$f'))")" = "$CURRENT_BEST_RANKER" ] || \
               [ "$(python3 -c "import os; print(os.path.abspath('$f'))")" = "$CURRENT_BEST_VALUE" ] || \
               [ "$(python3 -c "import os; print(os.path.abspath('$f'))")" = "$CURRENT_BEST_QVALUE" ]; then
                continue
            fi
            remove_tracked_item "$f"
        done
    fi

    # Baseline config
    remove_tracked_item "$ITER_DIR/self-play-config-baseline.json"

    if [ "$CLEANED_MB" != "0" ]; then
        echo -e "  \e[32mFreed $CLEANED_MB MB of disk space.\e[0m"
    else
        echo "  No intermediate files to clean."
    fi
done

# ============================================================
# Final summary
# ============================================================

TOTAL_DURATION=$(( $(date +%s) - START_TIME ))
TOTAL_DURATION_STR=$(format_duration $TOTAL_DURATION)

echo ""
echo -e "\e[36m$(printf '=%.0s' {1..70})\e[0m"
echo -e "\e[36m  ALL ITERATIONS COMPLETE\e[0m"
echo -e "\e[36m$(printf '=%.0s' {1..70})\e[0m"
echo ""
echo "  Total time: $TOTAL_DURATION_STR"

# Count promoted/skipped
TOTAL_PROMOTED=0
TOTAL_SKIPPED=0
for r in "${ITER_RESULTS[@]}"; do
    IFS='|' read -r iter status pw mae rmse samp dur <<< "$r"
    if [ "$status" = "PROMOTE" ]; then
        TOTAL_PROMOTED=$((TOTAL_PROMOTED + 1))
    elif [ "$status" = "SKIP" ]; then
        TOTAL_SKIPPED=$((TOTAL_SKIPPED + 1))
    fi
done
TOTAL_VALID=${#ITER_RESULTS[@]}
TOTAL_VALID=$((TOTAL_VALID - TOTAL_SKIPPED))
echo "  Promoted: $TOTAL_PROMOTED / $TOTAL_VALID"
if [ "$TOTAL_SKIPPED" -gt 0 ]; then
    echo "  Skipped:  $TOTAL_SKIPPED (insufficient samples)"
fi

echo ""
echo "  Results:"
echo "  ┌──────┬──────────┬──────────┬──────────┬──────────┬──────────┐"
echo "  │ Iter │ Pairwise │ MAE      │ Samples  │ Status   │ Duration │"
echo "  ├──────┼──────────┼──────────┼──────────┼──────────┼──────────┤"

for r in "${ITER_RESULTS[@]}"; do
    IFS='|' read -r iter status pw mae rmse samp dur <<< "$r"
    if [ "$status" = "SKIP" ]; then
        STATUS_DISPLAY="SKIP   "
    elif [ "$status" = "PROMOTE" ]; then
        STATUS_DISPLAY="PROMOTE"
    else
        STATUS_DISPLAY="REJECT "
    fi
    PW_DISPLAY=$(python3 -c "
pw = '$pw'
if pw and pw != 'None':
    print(f'{float(pw)*100:.1f}%')
else:
    print('N/A')
" 2>/dev/null || echo "N/A")
    MAE_DISPLAY=$(python3 -c "
mae = '$mae'
if mae and mae != 'None':
    print(f'{float(mae):.4f}')
else:
    print('N/A')
" 2>/dev/null || echo "N/A")
    SAMP_DISPLAY="${samp:-N/A}"
    printf "  │ %-4s │ %-8s │ %-8s │ %-8s │ %-8s │ %-8s │\n" "$iter" "$PW_DISPLAY" "$MAE_DISPLAY" "$SAMP_DISPLAY" "$STATUS_DISPLAY" "$dur"
done

echo "  └──────┴──────────┴──────────┴──────────┴──────────┴──────────┘"
echo ""

# Show final best model
get_best_artifacts
if [ -n "$BEST_RANKER" ]; then
    echo -e "  \e[32mFinal best model: iter $BEST_ITERATION\e[0m"
    echo "  Ranker: $BEST_RANKER"
    echo "  Value:  $BEST_VALUE"
else
    echo -e "  \e[33mNo model was promoted.\e[0m"
fi
echo ""