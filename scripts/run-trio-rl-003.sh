#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GI_AGENT_DIR="$ROOT_DIR/packages/gi-agent"
GI_ML_DIR="$ROOT_DIR/packages/gi-ml"
GENERATED_DIR="$GI_AGENT_DIR/output/generated-rl-003"

PYTHON_BIN="${PYTHON_BIN:-python3}"
BENCH_CONCURRENCY="${BENCH_CONCURRENCY:-4}"
PREFIX="${PREFIX:-rl_trio_003}"

SELFPLAY_DATASET_PATH="$GI_AGENT_DIR/output/rl-trio-003/rl-dataset.json"
SELFPLAY_MANIFEST_PATH="$GI_AGENT_DIR/output/rl-trio-003/rl-dataset.manifest.json"
SELFPLAY_SHARD_DIR="$GI_AGENT_DIR/output/rl-trio-003/rl-dataset.shards"
TRAIN_OUTPUT_DIR="$GI_ML_DIR/output/rl-formal-train-trio-003"
PREV_TRAIN_OUTPUT_DIR="${PREV_TRAIN_OUTPUT_DIR:-$GI_ML_DIR/output/rl-formal-train-trio}"
BENCHMARK_JSON_PATH="$GI_AGENT_DIR/output/benchmark-trio-rl-trio-003-vs-baseline.json"
BENCHMARK_MD_PATH="$GI_AGENT_DIR/output/benchmark-trio-rl-trio-003-vs-baseline.md"

mkdir -p "$GENERATED_DIR"

export GI_AGENT_DIR GI_ML_DIR GENERATED_DIR PREFIX SELFPLAY_MANIFEST_PATH TRAIN_OUTPUT_DIR PREV_TRAIN_OUTPUT_DIR
"$PYTHON_BIN" - <<'PY'
from __future__ import annotations

import json
import os
from pathlib import Path

gi_ml = Path(os.environ["GI_ML_DIR"])
generated = Path(os.environ["GENERATED_DIR"])
prefix = os.environ["PREFIX"]
selfplay_manifest_path = Path(os.environ["SELFPLAY_MANIFEST_PATH"])
train_output_dir = Path(os.environ["TRAIN_OUTPUT_DIR"])
prev_train_output_dir = Path(os.environ["PREV_TRAIN_OUTPUT_DIR"])

ranker_candidates = sorted(prev_train_output_dir.glob("*.ranker-artifact.python.json"))
value_candidates = sorted(prev_train_output_dir.glob("*.value-artifact.python.json"))
if not ranker_candidates:
    raise FileNotFoundError(f"No ranker artifact found under {prev_train_output_dir}")
if not value_candidates:
    raise FileNotFoundError(f"No value artifact found under {prev_train_output_dir}")

teacher_ranker = ranker_candidates[-1]
teacher_value = value_candidates[-1]
teacher_prefix = teacher_ranker.name.removesuffix(".ranker-artifact.python.json")

decks = {
    "PyroKe": "ASBg2xwOATAw408OBEDw5JAPCRAA9JcPCUBw9aoPClCg9rwPC2HAC8kQDLGQEdIRDTAA",
    "CryoHe": "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA",
    "HydroNing": "AKDQ4SoOABCQ4mYOByCg9HoPCWDQ+J0PC5Aw/bMPC9HACrwQC7HQC70QDOGQDskQDfAA",
}

pairs = [
    ("PyroKe", "PyroKe"),
    ("PyroKe", "CryoHe"),
    ("PyroKe", "HydroNing"),
    ("CryoHe", "PyroKe"),
    ("CryoHe", "CryoHe"),
    ("CryoHe", "HydroNing"),
    ("HydroNing", "PyroKe"),
    ("HydroNing", "CryoHe"),
    ("HydroNing", "HydroNing"),
]

excluded_draw_matchups = [
    "giml-vs-baseline:hydroning-vs-hydroning",
    "baseline-vs-giml:hydroning-vs-hydroning",
    "giml-mirror:hydroning-vs-hydroning",
]

def gi_ml_side(name: str) -> dict:
    return {
        "name": name,
        "kind": "gi-ml-runtime",
        "rankerArtifactPath": os.path.relpath(teacher_ranker, generated),
        "valueArtifactPath": os.path.relpath(teacher_value, generated),
        "options": {
            "endTurnPenalty": 5,
        },
    }

def baseline_side(name: str) -> dict:
    return {
        "name": name,
        "kind": "baseline",
        "options": {
            "endTurnPenalty": 5,
        },
    }

mixed_matchups = []
for deck0_name, deck1_name in pairs:
    deck0 = decks[deck0_name]
    deck1 = decks[deck1_name]

    games_gvb = 40 if deck0_name == "HydroNing" else 20
    mixed_matchups.append({
        "id": f"giml-vs-baseline:{deck0_name.lower()}-vs-{deck1_name.lower()}",
        "deck0Name": deck0_name,
        "deck1Name": deck1_name,
        "deck0": deck0,
        "deck1": deck1,
        "games": games_gvb,
        "sideA": gi_ml_side(f"{teacher_prefix}-a"),
        "sideB": baseline_side("baseline-b"),
    })

    games_bvg = 40 if deck1_name == "HydroNing" else 20
    mixed_matchups.append({
        "id": f"baseline-vs-giml:{deck0_name.lower()}-vs-{deck1_name.lower()}",
        "deck0Name": deck0_name,
        "deck1Name": deck1_name,
        "deck0": deck0,
        "deck1": deck1,
        "games": games_bvg,
        "sideA": baseline_side("baseline-a"),
        "sideB": gi_ml_side(f"{teacher_prefix}-b"),
    })

    games_mirror = 20 if ("HydroNing" in (deck0_name, deck1_name)) else 10
    mixed_matchups.append({
        "id": f"giml-mirror:{deck0_name.lower()}-vs-{deck1_name.lower()}",
        "deck0Name": deck0_name,
        "deck1Name": deck1_name,
        "deck0": deck0,
        "deck1": deck1,
        "games": games_mirror,
        "sideA": gi_ml_side(f"{teacher_prefix}-a"),
        "sideB": gi_ml_side(f"{teacher_prefix}-b"),
    })

benchmark_selfplay_path = generated / f"benchmark.trio.{teacher_prefix}-mixed-selfplay-003.generated.json"
benchmark_selfplay_path.write_text(
    json.dumps({"version": "v6.3.0", "matchups": mixed_matchups}, indent=2) + "\n",
    encoding="utf-8",
)

selfplay_config_path = generated / "self-play.rl.trio.003.generated.json"
selfplay_config_path.write_text(
    json.dumps(
        {
            "benchmarkPath": f"./{benchmark_selfplay_path.name}",
            "gamesMultiplier": 1,
            "rlCapture": {
                "directory": "../rl-trio-003/self-play-rl",
                "modelVersion": f"{teacher_prefix}-selfplay-003",
                "viewKind": "policy_public",
                "gameVersion": "v6.3.0",
                "cardPoolVersion": "v6.3.0",
                "rulesetVersion": "default",
                "contractVersion": "obs.v1",
            },
            "dataset": {
                "manifestPath": "../rl-trio-003/rl-dataset.manifest.json",
                "shardDir": "../rl-trio-003/rl-dataset.shards",
                "maxSamplesPerShard": 2000,
                "includeSides": [0, 1],
                "requireChosenCandidate": True,
                "excludeDrawMatchups": excluded_draw_matchups,
            },
            "outputPath": "../rl-trio-003/self-play-rl-result.json",
        },
        indent=2,
    ) + "\n",
    encoding="utf-8",
)

eval_ranker = train_output_dir / f"{prefix}.ranker-artifact.python.json"
eval_value = train_output_dir / f"{prefix}.value-artifact.python.json"
eval_matchups = []
for deck0_name, deck1_name in pairs:
    eval_matchups.append({
        "id": f"{deck0_name.lower()}-vs-{deck1_name.lower()}",
        "deck0Name": deck0_name,
        "deck1Name": deck1_name,
        "deck0": decks[deck0_name],
        "deck1": decks[deck1_name],
        "games": 20,
        "sideA": {
            "name": "rl-trio-003-a",
            "kind": "gi-ml-runtime",
            "rankerArtifactPath": os.path.relpath(eval_ranker, generated),
            "valueArtifactPath": os.path.relpath(eval_value, generated),
            "options": {
                "endTurnPenalty": 5,
            },
        },
        "sideB": baseline_side("baseline-b"),
    })

benchmark_eval_path = generated / "benchmark.trio.rl-trio-003-vs-baseline.generated.json"
benchmark_eval_path.write_text(
    json.dumps({"version": "v6.3.0", "matchups": eval_matchups}, indent=2) + "\n",
    encoding="utf-8",
)

print(f"generated_selfplay_benchmark={benchmark_selfplay_path}")
print(f"generated_selfplay_config={selfplay_config_path}")
print(f"generated_eval_benchmark={benchmark_eval_path}")
print(f"dataset_manifest={selfplay_manifest_path}")
print(f"teacher_ranker={teacher_ranker}")
print(f"teacher_value={teacher_value}")
PY

SELFPLAY_CONFIG_PATH="$GENERATED_DIR/self-play.rl.trio.003.generated.json"
EVAL_BENCHMARK_PATH="$GENERATED_DIR/benchmark.trio.rl-trio-003-vs-baseline.generated.json"

echo "[1/4] self-play mixed curriculum -> rl-trio-003"
cd "$GI_AGENT_DIR"
bun src/learning/rl/cli/run-self-play-rl-smoke.ts "$SELFPLAY_CONFIG_PATH"

echo "[2/4] formal train -> $PREFIX"
cd "$GI_ML_DIR"
bun src/cli/run-train-rl-formal-pipeline.ts \
  --input "$SELFPLAY_MANIFEST_PATH" \
  --output-dir "$TRAIN_OUTPUT_DIR" \
  --prefix "$PREFIX" \
  --python "$PYTHON_BIN" \
  --python-cwd ./python \
  --dataset-id "$PREFIX" \
  --version "$PREFIX"

echo "[3/4] export static-effect seed concepts"
bun run export:static-effect-seed-concepts \
  --input "$TRAIN_OUTPUT_DIR/${PREFIX}.ranking-dataset.json" \
  --output "$TRAIN_OUTPUT_DIR/${PREFIX}.static-effect-seed-concepts.json"

echo "[4/4] benchmark vs baseline"
cd "$GI_AGENT_DIR"
bun src/evaluation/benchmark/cli/run-benchmark.ts \
  "$EVAL_BENCHMARK_PATH" \
  --output "$BENCHMARK_JSON_PATH" \
  --markdown "$BENCHMARK_MD_PATH" \
  --concurrency "$BENCH_CONCURRENCY"

echo
echo "Done."
echo "Dataset manifest: $SELFPLAY_MANIFEST_PATH"
echo "Dataset shards: $SELFPLAY_SHARD_DIR"
echo "Bundle: $TRAIN_OUTPUT_DIR/${PREFIX}.bundle.json"
echo "Seed concepts: $TRAIN_OUTPUT_DIR/${PREFIX}.static-effect-seed-concepts.json"
echo "Benchmark markdown: $BENCHMARK_MD_PATH"
