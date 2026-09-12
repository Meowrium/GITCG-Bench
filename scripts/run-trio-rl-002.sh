#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GI_AGENT_DIR="$ROOT_DIR/packages/gi-agent"
GI_ML_DIR="$ROOT_DIR/packages/gi-ml"
GENERATED_DIR="$GI_AGENT_DIR/output/generated-rl-002"

PYTHON_BIN="${PYTHON_BIN:-python3}"
BENCH_CONCURRENCY="${BENCH_CONCURRENCY:-4}"
PREFIX="${PREFIX:-rl_trio_002}"

SELFPLAY_DATASET_PATH="$GI_AGENT_DIR/output/rl-trio-002/rl-dataset.json"
SELFPLAY_MANIFEST_PATH="$GI_AGENT_DIR/output/rl-trio-002/rl-dataset.manifest.json"
SELFPLAY_SHARD_DIR="$GI_AGENT_DIR/output/rl-trio-002/rl-dataset.shards"
TRAIN_OUTPUT_DIR="$GI_ML_DIR/output/rl-formal-train-trio-002"
BENCHMARK_JSON_PATH="$GI_AGENT_DIR/output/benchmark-trio-rl-trio-002-vs-baseline.json"
BENCHMARK_MD_PATH="$GI_AGENT_DIR/output/benchmark-trio-rl-trio-002-vs-baseline.md"

mkdir -p "$GENERATED_DIR"

export ROOT_DIR GI_AGENT_DIR GI_ML_DIR GENERATED_DIR PREFIX SELFPLAY_DATASET_PATH SELFPLAY_MANIFEST_PATH SELFPLAY_SHARD_DIR TRAIN_OUTPUT_DIR
"$PYTHON_BIN" - <<'PY'
from __future__ import annotations

import json
import os
from pathlib import Path

root = Path(os.environ["ROOT_DIR"])
gi_agent = Path(os.environ["GI_AGENT_DIR"])
gi_ml = Path(os.environ["GI_ML_DIR"])
generated = Path(os.environ["GENERATED_DIR"])
prefix = os.environ["PREFIX"]
selfplay_dataset_path = Path(os.environ["SELFPLAY_DATASET_PATH"])
selfplay_manifest_path = Path(os.environ["SELFPLAY_MANIFEST_PATH"])
selfplay_shard_dir = Path(os.environ["SELFPLAY_SHARD_DIR"])
train_output_dir = Path(os.environ["TRAIN_OUTPUT_DIR"])

teacher_ranker = gi_ml / "output" / "rl-warm-start-bundle-static-priors" / "rl_trio_static_priors_001.ranker-artifact.json"
teacher_value = gi_ml / "output" / "rl-warm-start-bundle-static-priors" / "rl_trio_static_priors_001.value-artifact.json"

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
        "sideA": gi_ml_side("gi-ml-static-priors-a"),
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
        "sideB": gi_ml_side("gi-ml-static-priors-b"),
    })

    games_mirror = 20 if ("HydroNing" in (deck0_name, deck1_name)) else 10
    mixed_matchups.append({
        "id": f"giml-mirror:{deck0_name.lower()}-vs-{deck1_name.lower()}",
        "deck0Name": deck0_name,
        "deck1Name": deck1_name,
        "deck0": deck0,
        "deck1": deck1,
        "games": games_mirror,
        "sideA": gi_ml_side("gi-ml-static-priors-a"),
        "sideB": gi_ml_side("gi-ml-static-priors-b"),
    })

benchmark_selfplay_path = generated / "benchmark.trio.giml-static-priors-mixed-selfplay-002.generated.json"
benchmark_selfplay_path.write_text(
    json.dumps({"version": "v6.3.0", "matchups": mixed_matchups}, indent=2) + "\n",
    encoding="utf-8",
)

selfplay_config_path = generated / "self-play.rl.trio.002.generated.json"
selfplay_config_path.write_text(
    json.dumps(
        {
            "benchmarkPath": f"./{benchmark_selfplay_path.name}",
            "gamesMultiplier": 1,
            "rlCapture": {
                "directory": "../rl-trio-002/self-play-rl",
                "modelVersion": "trio-giml-static-priors-mixed-002",
                "viewKind": "policy_public",
                "gameVersion": "v6.3.0",
                "cardPoolVersion": "v6.3.0",
                "rulesetVersion": "default",
                "contractVersion": "obs.v1",
            },
            "dataset": {
                "manifestPath": "../rl-trio-002/rl-dataset.manifest.json",
                "shardDir": "../rl-trio-002/rl-dataset.shards",
                "maxSamplesPerShard": 2000,
                "includeSides": [0, 1],
                "requireChosenCandidate": True,
            },
            "outputPath": "../rl-trio-002/self-play-rl-result.json",
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
            "name": "rl-trio-002-a",
            "kind": "gi-ml-runtime",
            "rankerArtifactPath": os.path.relpath(eval_ranker, generated),
            "valueArtifactPath": os.path.relpath(eval_value, generated),
            "options": {
                "endTurnPenalty": 5,
            },
        },
        "sideB": baseline_side("baseline-b"),
    })

benchmark_eval_path = generated / "benchmark.trio.rl-trio-002-vs-baseline.generated.json"
benchmark_eval_path.write_text(
    json.dumps({"version": "v6.3.0", "matchups": eval_matchups}, indent=2) + "\n",
    encoding="utf-8",
)

print(f"generated_selfplay_benchmark={benchmark_selfplay_path}")
print(f"generated_selfplay_config={selfplay_config_path}")
print(f"generated_eval_benchmark={benchmark_eval_path}")
PY

SELFPLAY_CONFIG_PATH="$GENERATED_DIR/self-play.rl.trio.002.generated.json"
EVAL_BENCHMARK_PATH="$GENERATED_DIR/benchmark.trio.rl-trio-002-vs-baseline.generated.json"

echo "[1/4] self-play mixed curriculum -> rl-trio-002"
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
