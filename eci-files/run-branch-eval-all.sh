#!/bin/bash
# Branch Eval All — template runner script for ECI deployment
# Processes all matchups from bench-config.json with parallel concurrency
# Usage: set CONCURRENCY env var (default 4), mount NAS at /mnt/nas, run this script

set -eu

APP=/app
NAS_BASE=/mnt/nas/v20-greedy-10deck       # ← ADJUST per pipeline version
NAS_REPLAYS=$NAS_BASE/replays
NAS_ARTIFACTS=$NAS_BASE/artifacts
RESULTS=$APP/results/branch-eval
CONCURRENCY=${CONCURRENCY:-4}

mkdir -p $RESULTS

# ── NAS output dir (create early for immediate writes) ──
NAS_OUT=$NAS_BASE/branch-eval
mkdir -p $NAS_OUT 2>/dev/null || true

# ── Wait for NAS mount ──
for i in $(seq 1 30); do
  if mountpoint -q /mnt/nas 2>/dev/null && ls $NAS_REPLAYS/ 2>/dev/null | head -1 >/dev/null; then
    echo "[$(date '+%H:%M:%S')] NAS ready: $(ls $NAS_REPLAYS | wc -l) replay dirs"
    break
  fi
  echo "[$(date '+%H:%M:%S')] Waiting for NAS... ($i)"
  sleep 2
done

if ! ls $NAS_REPLAYS/ 2>/dev/null | head -1 >/dev/null; then
  echo "ERROR: NAS replays not accessible"
  exit 1
fi

# ── Generate bench-pipeline-config with artifact paths ──
echo "[$(date '+%H:%M:%S')] Generating bench-pipeline-config.json..."
python3 << PYEOF
import json
with open("$APP/bench-config.json") as f:
    bc = json.load(f)
for m in bc["matchups"]:
    m["sideA"]["rankerArtifactPath"] = "$NAS_ARTIFACTS/v20.ranker-artifact.json"
    m["sideA"]["valueArtifactPath"] = "$NAS_ARTIFACTS/v20.value-artifact.json"
    m["sideA"]["name"] = "V20-Greedy-10Deck"
with open("$APP/bench-pipeline-config.json", "w") as f:
    json.dump(bc, f, indent=2, ensure_ascii=False)
print(f"  {len(bc['matchups'])} matchups configured")
PYEOF

# ── Generate individual branch-eval configs ──
echo "[$(date '+%H:%M:%S')] Generating branch-eval configs..."
CONFIG_DIR=$APP/branch-eval-configs
mkdir -p $CONFIG_DIR

python3 << PYEOF
import json, os

with open("$APP/bench-config.json") as f:
    bc = json.load(f)

for m in bc["matchups"]:
    mid = m["id"]
    cfg = {
        "benchmarkPath": "$APP/bench-pipeline-config.json",
        "matchupId": mid,
        "replayDir": "$NAS_REPLAYS/" + mid,
        "sampleCount": 50,
        "minLegalActions": 3,
        "maxBranchesPerPoint": 5,
        "continuationGamesPerBranch": 5,
        "outputPath": "$RESULTS/" + mid + ".json"
    }
    with open(f"$CONFIG_DIR/{mid}.json", "w") as f:
        json.dump(cfg, f, indent=2)

print(f"  {len(bc['matchups'])} configs written")
PYEOF

# ── Run branch-eval for all matchups (parallel) ──
echo "[$(date '+%H:%M:%S')] Starting branch-eval ($CONCURRENCY concurrent)..."
TOTAL=$(ls $CONFIG_DIR/*.json | wc -l)
echo "  Total matchups: $TOTAL"

cd $APP/packages/gi-agent

process_one() {
    local config_file=$1
    local mid=$(basename "$config_file" .json)
    local logfile="$APP/pipeline-logs/branch-eval-$mid.log"
    local timeout_sec=1800  # 30 min per matchup (with Fix2 320x faster, a matchup should finish in 3-5 min)

    echo "[$(date '+%H:%M:%S')] START $mid" | tee "$logfile"
    if timeout $timeout_sec bun run src/evaluation/branch-eval/run-branch-eval.ts "$config_file" >> "$logfile" 2>&1; then
        echo "[$(date '+%H:%M:%S')] DONE  $mid" | tee -a "$logfile"
        # Immediately save to NAS so we don't lose progress on crash
        cp "$RESULTS/$mid.json" "$NAS_OUT/" 2>/dev/null || true
        echo "[$(date '+%H:%M:%S')] SAVED $mid to NAS" >> "$logfile"
        return 0
    else
        local exit_code=$?
        if [ $exit_code -eq 124 ]; then
            echo "[$(date '+%H:%M:%S')] TIMEOUT $mid (killed after ${timeout_sec}s)" | tee -a "$logfile"
        else
            echo "[$(date '+%H:%M:%S')] FAIL  $mid (exit=$exit_code)" | tee -a "$logfile"
        fi
        return 1
    fi
}

export -f process_one
export APP RESULTS NAS_OUT

mkdir -p $APP/pipeline-logs

ls $CONFIG_DIR/*.json | xargs -P $CONCURRENCY -I {} bash -c 'process_one "$@"' _ {}

# ── Count results ──
COMPLETED=$(ls $RESULTS/*.json 2>/dev/null | wc -l)
FAILED=$((TOTAL - COMPLETED))
echo ""
echo "══════════════════════════════════════════"
echo "[$(date '+%H:%M:%S')] Branch eval complete!"
echo "  Completed: $COMPLETED / $TOTAL"
echo "  Failed: $FAILED"

# ── Aggregate ──
if [ $COMPLETED -gt 0 ]; then
    echo ""
    echo "[$(date '+%H:%M:%S')] Aggregating results..."
    python3 << PYEOF
import json, os

results = []
for f in sorted(os.listdir("$RESULTS")):
    if f.endswith('.json'):
        with open(os.path.join("$RESULTS", f)) as fp:
            results.append(json.load(fp))

total_points = sum(r.get('sampleCount', 0) for r in results)
total_branches = sum(
    len(p.get('branches', [])) 
    for r in results 
    for p in r.get('points', [])
)

match_stats = []
for r in results:
    points = r.get('points', [])
    if not points:
        continue
    policy_matches = sum(1 for p in points if p.get('policySelectedActionIndex') == p.get('replayActionIndex'))
    best_wr = []
    for p in points:
        wrs = [b['continuation']['winRate'] for b in p.get('branches', [])]
        if wrs:
            best_wr.append(max(wrs))
    
    match_stats.append({
        'matchupId': r.get('matchupId'),
        'sampleCount': len(points),
        'policyMatchRate': policy_matches / len(points) if points else 0,
        'avgBestWR': sum(best_wr) / len(best_wr) if best_wr else 0,
    })

aggregate = {
    'total_matchups': len(results),
    'total_points': total_points,
    'total_branches': total_branches,
    'avg_policy_match_rate': sum(m['policyMatchRate'] for m in match_stats) / len(match_stats) if match_stats else 0,
    'avg_best_wr': sum(m['avgBestWR'] for m in match_stats) / len(match_stats) if match_stats else 0,
    'matchups': match_stats
}

with open("$RESULTS/aggregate.json", 'w') as f:
    json.dump(aggregate, f, indent=2)

print(f"  {len(results)} matchups, {total_points} points, {total_branches} branches")
PYEOF
fi

# ── Save to NAS ──
NAS_OUT=$NAS_BASE/branch-eval
mkdir -p $NAS_OUT
cp $RESULTS/aggregate.json $NAS_OUT/ 2>/dev/null || true
cp -r $RESULTS/*.json $NAS_OUT/ 2>/dev/null || true
echo "[$(date '+%H:%M:%S')] Results saved to $NAS_OUT"

# ── Full-game deep analysis (pick one game, analyze ALL decision points) ──
echo ""
echo "[$(date '+%H:%M:%S')] Full-game deep analysis..."
# Pick the first replay file from the first matchup with replays
DEEP_MATCHUP=$(ls $NAS_REPLAYS/ 2>/dev/null | head -1)
DEEP_FILE=$(ls $NAS_REPLAYS/$DEEP_MATCHUP/*.json 2>/dev/null | head -1)
if [ -n "$DEEP_FILE" ]; then
    DEEP_GAME=$(basename "$DEEP_FILE" .json)
    echo "  Game: $DEEP_MATCHUP / $DEEP_GAME"
    
    # Create a temp dir with just this one game, so branch-eval processes ALL its decision points
    DEEP_TMP_DIR=$APP/deep-replay
    mkdir -p $DEEP_TMP_DIR
    cp "$DEEP_FILE" "$DEEP_TMP_DIR/"
    
    # Generate config
    python3 << PYEOF
import json
cfg = {
    "benchmarkPath": "$APP/bench-pipeline-config.json",
    "matchupId": "$DEEP_MATCHUP",
    "replayDir": "$DEEP_TMP_DIR",
    "sampleCount": 999,
    "minLegalActions": 1,
    "maxBranchesPerPoint": 5,
    "continuationGamesPerBranch": 5,
    "outputPath": "$RESULTS/deep-analysis.json"
}
with open("$CONFIG_DIR/deep-analysis.json", "w") as f:
    json.dump(cfg, f, indent=2)
print(f"  Deep analysis config written")
PYEOF

    cd $APP/packages/gi-agent
    timeout 600 bun run src/evaluation/branch-eval/run-branch-eval.ts "$CONFIG_DIR/deep-analysis.json" 2>&1 | tail -5
    cp "$RESULTS/deep-analysis.json" "$NAS_OUT/" 2>/dev/null || true
    echo "[$(date '+%H:%M:%S')] Deep analysis saved"
else
    echo "  WARNING: No replay files found for deep analysis"
fi

# Keep alive for log inspection
sleep 120
