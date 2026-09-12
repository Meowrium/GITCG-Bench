#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GI_AGENT_DIR="$ROOT_DIR/packages/gi-agent"
GENERATED_DIR="$GI_AGENT_DIR/output/generated-rl-004"

FULL_BENCHMARK_CONFIG_PATH="$GENERATED_DIR/benchmark.trio.rl-trio-004-vs-baseline.generated.json"
BENCHMARK_RESULT_PATH="$GI_AGENT_DIR/output/benchmark-trio-rl-trio-004-vs-baseline.json"

WEAK_SAMPLE_CONFIG_PATH="$GENERATED_DIR/benchmark.trio.rl-trio-004-weak-sample.generated.json"
WEAK_SAMPLE_SELECTION_PATH="$GENERATED_DIR/benchmark.trio.rl-trio-004-weak-sample.selection.json"
WEAK_SAMPLE_RESULT_JSON_PATH="$GI_AGENT_DIR/output/benchmark-trio-rl-trio-004-weak-sample.json"
WEAK_SAMPLE_RESULT_MD_PATH="$GI_AGENT_DIR/output/benchmark-trio-rl-trio-004-weak-sample.md"

MAX_MATCHUPS="${MAX_MATCHUPS:-4}"
WINRATE_THRESHOLD="${WINRATE_THRESHOLD:-0.30}"
GAMES_PER_MATCHUP="${GAMES_PER_MATCHUP:-12}"
SAMPLE_LOGS_PER_MATCHUP="${SAMPLE_LOGS_PER_MATCHUP:-6}"
BENCH_CONCURRENCY="${BENCH_CONCURRENCY:-4}"
RUN_LABEL="${RUN_LABEL:-$(date +%Y%m%d-%H%M%S)}"
SAMPLE_LOGS_DIR="${SAMPLE_LOGS_DIR:-$GI_AGENT_DIR/output/replay-samples/rl-trio-004-weak-review-$RUN_LABEL}"
MATCHUP_IDS="${MATCHUP_IDS:-}"
EXCLUDE_MATCHUP_IDS="${EXCLUDE_MATCHUP_IDS:-hydroning-vs-hydroning}"
BUN_BIN="${BUN_BIN:-}"

if [[ ! -f "$FULL_BENCHMARK_CONFIG_PATH" ]]; then
  echo "Full benchmark config not found: $FULL_BENCHMARK_CONFIG_PATH" >&2
  exit 1
fi

if [[ ! -f "$BENCHMARK_RESULT_PATH" ]]; then
  echo "Benchmark result not found: $BENCHMARK_RESULT_PATH" >&2
  exit 1
fi

if [[ -z "$BUN_BIN" ]]; then
  if command -v bun >/dev/null 2>&1; then
    BUN_BIN="$(command -v bun)"
  else
    for candidate in /mnt/c/Users/*/.bun/bin/bun.exe; do
      if [[ -f "$candidate" ]]; then
        BUN_BIN="$candidate"
        break
      fi
    done
  fi
fi

if [[ -z "$BUN_BIN" ]]; then
  echo "Unable to find bun. Set BUN_BIN explicitly before running this script." >&2
  exit 1
fi

python3 - "$FULL_BENCHMARK_CONFIG_PATH" "$BENCHMARK_RESULT_PATH" "$WEAK_SAMPLE_CONFIG_PATH" "$WEAK_SAMPLE_SELECTION_PATH" "$MAX_MATCHUPS" "$WINRATE_THRESHOLD" "$GAMES_PER_MATCHUP" "$MATCHUP_IDS" "$EXCLUDE_MATCHUP_IDS" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

full_config_path = Path(sys.argv[1])
benchmark_result_path = Path(sys.argv[2])
weak_config_path = Path(sys.argv[3])
selection_path = Path(sys.argv[4])
max_matchups = int(sys.argv[5])
winrate_threshold = float(sys.argv[6])
games_per_matchup = int(sys.argv[7])
matchup_ids_arg = sys.argv[8].strip()
exclude_matchup_ids_arg = sys.argv[9].strip()

full_config = json.loads(full_config_path.read_text(encoding="utf-8"))
benchmark_result = json.loads(benchmark_result_path.read_text(encoding="utf-8"))

result_rows = benchmark_result["result"]["results"]
config_matchups = {matchup["id"]: matchup for matchup in full_config["matchups"]}
excluded_matchup_ids = {value.strip() for value in exclude_matchup_ids_arg.split(",") if value.strip()}

explicit_matchup_ids = [value.strip() for value in matchup_ids_arg.split(",") if value.strip()]
if explicit_matchup_ids:
    selected_rows = []
    for matchup_id in explicit_matchup_ids:
        row = next((row for row in result_rows if row["matchupId"] == matchup_id), None)
        if row is None:
            raise SystemExit(f"Requested matchup not found in benchmark result: {matchup_id}")
        selected_rows.append(row)
else:
    ordered_rows = sorted(
        [
            row for row in result_rows
            if row["matchupId"] not in excluded_matchup_ids
        ],
        key=lambda row: row["batch"]["winRateP0"]
    )
    selected_rows = [
        row for row in ordered_rows
        if row["batch"]["winRateP0"] <= winrate_threshold
    ][:max_matchups]
    if not selected_rows:
        selected_rows = ordered_rows[:max_matchups]

selected_ids = [row["matchupId"] for row in selected_rows]
selected_matchups = []
for matchup_id in selected_ids:
    matchup = config_matchups.get(matchup_id)
    if matchup is None:
        raise SystemExit(f"Matchup missing from full benchmark config: {matchup_id}")
    selected_matchups.append({
        **matchup,
        "games": games_per_matchup,
    })

weak_config = {
    "version": full_config.get("version", "v6.3.0"),
    "matchups": selected_matchups,
}

selection_payload = {
    "selection_kind": "weak_matchup_replay_sample.v1",
    "source_benchmark_result": str(benchmark_result_path),
    "source_benchmark_config": str(full_config_path),
    "max_matchups": max_matchups,
    "winrate_threshold": winrate_threshold,
    "games_per_matchup": games_per_matchup,
    "selected_matchups": [
        {
            "matchup_id": row["matchupId"],
            "win_rate_p0": row["batch"]["winRateP0"],
            "wins_p0": row["batch"]["winsP0"],
            "wins_p1": row["batch"]["winsP1"],
            "draws": row["batch"]["draws"],
            "avg_rounds": row["batch"]["avgRounds"],
        }
        for row in selected_rows
    ],
}

weak_config_path.write_text(json.dumps(weak_config, indent=2) + "\n", encoding="utf-8")
selection_path.write_text(json.dumps(selection_payload, indent=2) + "\n", encoding="utf-8")

print(f"selected_matchup_count={len(selected_rows)}")
for row in selected_rows:
    print(
        "selected_matchup="
        f"{row['matchupId']} "
        f"win_rate={row['batch']['winRateP0']:.4f} "
        f"record={row['batch']['winsP0']}-{row['batch']['winsP1']}-{row['batch']['draws']}"
    )
print(f"generated_config={weak_config_path}")
print(f"selection_summary={selection_path}")
PY

echo "[sample] benchmark weak matchups with replay capture"
echo "bun_bin=$BUN_BIN"
cd "$GI_AGENT_DIR"
"$BUN_BIN" src/evaluation/benchmark/cli/run-benchmark.ts \
  "$WEAK_SAMPLE_CONFIG_PATH" \
  --output "$WEAK_SAMPLE_RESULT_JSON_PATH" \
  --markdown "$WEAK_SAMPLE_RESULT_MD_PATH" \
  --concurrency "$BENCH_CONCURRENCY" \
  --sample-logs-dir "$SAMPLE_LOGS_DIR" \
  --sample-logs-per-matchup "$SAMPLE_LOGS_PER_MATCHUP"

echo
echo "Replay sampling complete."
echo "Weak config: $WEAK_SAMPLE_CONFIG_PATH"
echo "Selection summary: $WEAK_SAMPLE_SELECTION_PATH"
echo "Replay samples: $SAMPLE_LOGS_DIR"
echo "Benchmark json: $WEAK_SAMPLE_RESULT_JSON_PATH"
echo "Benchmark markdown: $WEAK_SAMPLE_RESULT_MD_PATH"
echo "Filename suffixes:"
echo "  - p0 = sideA (candidate) win"
echo "  - p1 = sideA (candidate) loss"
echo "  - draw = draw"
