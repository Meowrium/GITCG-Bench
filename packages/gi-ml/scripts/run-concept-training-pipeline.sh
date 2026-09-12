#!/usr/bin/env bash
# Copyright (C) 2024-2025 Guyutongxue
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
GI_ML_DIR="$REPO_DIR/packages/gi-ml"
PY_DIR="$GI_ML_DIR/python"

# JS CLI runner. Default: `pnpm exec gnx` (gnx wraps tsx — see packages/config/bin/gnx.mjs).
# Override with: `JS_RUNNER="bun"` to use bun, or any custom command.
JS_RUNNER="${JS_RUNNER:-pnpm exec gnx}"

# Adjustable Parameters
RUN_LABEL="${RUN_LABEL:-concept-training}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
VENV_DIR="${VENV_DIR:-$PY_DIR/.venv}"
INSTALL_ENV="${INSTALL_ENV:-1}"
TRAIN_PRESET="${TRAIN_PRESET:-laptop}"

DATASET_INPUT="${DATASET_INPUT:-$GI_ML_DIR/output/branch-eval-dataset.smoke.json}"
COMBAT_CONCEPTS_INPUT="${COMBAT_CONCEPTS_INPUT:-}"
COMBO_CONCEPTS_INPUT="${COMBO_CONCEPTS_INPUT:-}"
TREE_LAKE_INPUT="${TREE_LAKE_INPUT:-$REPO_DIR/packages/gi-agent/output/combat-windows/tree-lake.sqlite}"
AUTO_EXPORT_COMBO_CONCEPTS="${AUTO_EXPORT_COMBO_CONCEPTS:-1}"
MERGED_BANK_VERSION="${MERGED_BANK_VERSION:-${RUN_LABEL}_bank_v1}"

case "$TRAIN_PRESET" in
  laptop)
    DEFAULT_MIN_SUPPORT=2
    DEFAULT_MIN_MEAN_CONFIDENCE=0.08
    DEFAULT_EPOCHS_RANKER=16
    DEFAULT_EPOCHS_CONCEPT=12
    DEFAULT_LEARNING_RATE=0.05
    DEFAULT_L2=0.001
    DEFAULT_TOP_TAGS=24
    DEFAULT_TOP_CANDIDATE_SLOTS=24
    DEFAULT_TOP_QUERY_SLOTS=16
    DEFAULT_TOP_FEATURES=16
    ;;
  cloud)
    DEFAULT_MIN_SUPPORT=2
    DEFAULT_MIN_MEAN_CONFIDENCE=0.04
    DEFAULT_EPOCHS_RANKER=64
    DEFAULT_EPOCHS_CONCEPT=48
    DEFAULT_LEARNING_RATE=0.06
    DEFAULT_L2=0.0003
    DEFAULT_TOP_TAGS=96
    DEFAULT_TOP_CANDIDATE_SLOTS=96
    DEFAULT_TOP_QUERY_SLOTS=48
    DEFAULT_TOP_FEATURES=64
    ;;
  *)
    echo "Unsupported TRAIN_PRESET: $TRAIN_PRESET" >&2
    echo "Expected one of: laptop, cloud" >&2
    exit 1
    ;;
esac

MIN_SUPPORT="${MIN_SUPPORT:-$DEFAULT_MIN_SUPPORT}"
MIN_MEAN_CONFIDENCE="${MIN_MEAN_CONFIDENCE:-$DEFAULT_MIN_MEAN_CONFIDENCE}"
EPOCHS_RANKER="${EPOCHS_RANKER:-$DEFAULT_EPOCHS_RANKER}"
EPOCHS_CONCEPT="${EPOCHS_CONCEPT:-$DEFAULT_EPOCHS_CONCEPT}"
LEARNING_RATE="${LEARNING_RATE:-$DEFAULT_LEARNING_RATE}"
L2="${L2:-$DEFAULT_L2}"
TOP_TAGS="${TOP_TAGS:-$DEFAULT_TOP_TAGS}"
TOP_CANDIDATE_SLOTS="${TOP_CANDIDATE_SLOTS:-$DEFAULT_TOP_CANDIDATE_SLOTS}"
TOP_QUERY_SLOTS="${TOP_QUERY_SLOTS:-$DEFAULT_TOP_QUERY_SLOTS}"
TOP_FEATURES="${TOP_FEATURES:-$DEFAULT_TOP_FEATURES}"
AUTO_EXPORT_BRANCH_EVAL_COMBO_CONCEPTS="${AUTO_EXPORT_BRANCH_EVAL_COMBO_CONCEPTS:-1}"
BRANCH_EVAL_COMBO_MIN_SUPPORT="${BRANCH_EVAL_COMBO_MIN_SUPPORT:-$MIN_SUPPORT}"
BRANCH_EVAL_COMBO_MIN_MEAN_CONFIDENCE="${BRANCH_EVAL_COMBO_MIN_MEAN_CONFIDENCE:-$MIN_MEAN_CONFIDENCE}"
BRANCH_EVAL_COMBO_MIN_STEPS="${BRANCH_EVAL_COMBO_MIN_STEPS:-2}"
BRANCH_EVAL_COMBO_MAX_STEPS="${BRANCH_EVAL_COMBO_MAX_STEPS:-4}"
BRANCH_EVAL_COMBO_MAX_POINT_GAP="${BRANCH_EVAL_COMBO_MAX_POINT_GAP:-12}"

OUTPUT_ROOT="${OUTPUT_ROOT:-$GI_ML_DIR/output/$RUN_LABEL}"
BRANCH_EVAL_CONCEPTS_OUTPUT="$OUTPUT_ROOT/branch-eval-concepts.json"
AUTO_COMBO_CONCEPTS_OUTPUT="$OUTPUT_ROOT/combo-window-concepts.json"
AUTO_BRANCH_EVAL_COMBO_CONCEPTS_OUTPUT="$OUTPUT_ROOT/branch-eval-combo-concepts.entity.long-window.json"
DISCOVERED_BANK_OUTPUT="$OUTPUT_ROOT/concept-bank.json"
CONCEPT_TARGETS_OUTPUT="$OUTPUT_ROOT/concept-targets.json"
CONCEPT_MODEL_OUTPUT="$OUTPUT_ROOT/concept-model.json"
RANKER_ARTIFACT_OUTPUT="$OUTPUT_ROOT/ranker-artifact.json"
RANKER_EVAL_OUTPUT="$OUTPUT_ROOT/ranker-eval.json"

mkdir -p "$OUTPUT_ROOT"

if [[ ! -f "$DATASET_INPUT" ]]; then
  echo "DATASET_INPUT does not exist: $DATASET_INPUT" >&2
  exit 1
fi

if [[ "$INSTALL_ENV" == "1" ]]; then
  echo "==> Creating/updating Python environment at $VENV_DIR"
  "$PYTHON_BIN" -m venv "$VENV_DIR"
  source "$VENV_DIR/bin/activate"
  python -m pip install --upgrade pip setuptools wheel
  python -m pip install -e "$PY_DIR"
else
  source "$VENV_DIR/bin/activate"
fi

# Path passthrough. Previously to_bun_path performed wslpath conversion when
# JS_RUNNER pointed at a Windows-side bun.exe. Under pnpm/tsx in WSL, native
# Linux paths work directly. Kept as a function for any caller still routing
# inputs through it; replace the body with `wslpath -w "$1"` if you need to
# point JS_RUNNER at a Windows-side .exe again.
to_runner_path() {
  printf '%s\n' "$1"
}

DATASET_INPUT="$(to_runner_path "$DATASET_INPUT")"
BRANCH_EVAL_CONCEPTS_OUTPUT="$(to_runner_path "$BRANCH_EVAL_CONCEPTS_OUTPUT")"
AUTO_COMBO_CONCEPTS_OUTPUT="$(to_runner_path "$AUTO_COMBO_CONCEPTS_OUTPUT")"
AUTO_BRANCH_EVAL_COMBO_CONCEPTS_OUTPUT="$(to_runner_path "$AUTO_BRANCH_EVAL_COMBO_CONCEPTS_OUTPUT")"
DISCOVERED_BANK_OUTPUT="$(to_runner_path "$DISCOVERED_BANK_OUTPUT")"
RANKER_ARTIFACT_OUTPUT="$(to_runner_path "$RANKER_ARTIFACT_OUTPUT")"
RANKER_EVAL_OUTPUT="$(to_runner_path "$RANKER_EVAL_OUTPUT")"

if [[ -z "$COMBO_CONCEPTS_INPUT" && "$AUTO_EXPORT_COMBO_CONCEPTS" == "1" && -f "$TREE_LAKE_INPUT" ]]; then
  echo "==> [0/6] Exporting combo-window concepts from tree-lake"
  (
    cd "$GI_ML_DIR"
    $JS_RUNNER ./src/cli/run-export-combo-window-concepts.ts \
      --tree-lake "$(to_runner_path "$TREE_LAKE_INPUT")" \
      --output "$AUTO_COMBO_CONCEPTS_OUTPUT"
  )
  COMBO_CONCEPTS_INPUT="$AUTO_COMBO_CONCEPTS_OUTPUT"
fi

if [[ -z "$COMBO_CONCEPTS_INPUT" && "$AUTO_EXPORT_BRANCH_EVAL_COMBO_CONCEPTS" == "1" ]]; then
  echo "==> [0/6] Exporting entity-aware branch-eval combo concepts"
  (
    cd "$GI_ML_DIR"
    $JS_RUNNER ./src/cli/export/run-export-branch-eval-combo-concepts.ts \
      --input "$DATASET_INPUT" \
      --output "$AUTO_BRANCH_EVAL_COMBO_CONCEPTS_OUTPUT" \
      --min-support "$BRANCH_EVAL_COMBO_MIN_SUPPORT" \
      --min-mean-confidence "$BRANCH_EVAL_COMBO_MIN_MEAN_CONFIDENCE" \
      --min-combo-steps "$BRANCH_EVAL_COMBO_MIN_STEPS" \
      --max-combo-steps "$BRANCH_EVAL_COMBO_MAX_STEPS" \
      --max-point-gap "$BRANCH_EVAL_COMBO_MAX_POINT_GAP"
  )
  COMBO_CONCEPTS_INPUT="$AUTO_BRANCH_EVAL_COMBO_CONCEPTS_OUTPUT"
fi

concept_input_paths=("$BRANCH_EVAL_CONCEPTS_OUTPUT")
if [[ -n "$COMBAT_CONCEPTS_INPUT" ]]; then
  if [[ ! -f "$COMBAT_CONCEPTS_INPUT" ]]; then
    echo "COMBAT_CONCEPTS_INPUT does not exist: $COMBAT_CONCEPTS_INPUT" >&2
    exit 1
  fi
  concept_input_paths=("$COMBAT_CONCEPTS_INPUT" "${concept_input_paths[@]}")
fi
if [[ -n "$COMBO_CONCEPTS_INPUT" ]]; then
  if [[ ! -f "$COMBO_CONCEPTS_INPUT" ]]; then
    echo "COMBO_CONCEPTS_INPUT does not exist: $COMBO_CONCEPTS_INPUT" >&2
    exit 1
  fi
  concept_input_paths=("$COMBO_CONCEPTS_INPUT" "${concept_input_paths[@]}")
fi

concept_input_paths_run=()
for input_path in "${concept_input_paths[@]}"; do
  concept_input_paths_run+=("$(to_runner_path "$input_path")")
done
INPUTS="$(IFS=,; printf '%s' "${concept_input_paths_run[*]}")"

echo "==> [1/6] Discovering branch-eval concepts"
(
  cd "$GI_ML_DIR"
  $JS_RUNNER ./src/cli/export/run-export-branch-eval-concepts.ts \
    --input "$DATASET_INPUT" \
    --output "$BRANCH_EVAL_CONCEPTS_OUTPUT" \
    --min-support "$MIN_SUPPORT" \
    --min-mean-confidence "$MIN_MEAN_CONFIDENCE"
)

echo "==> [2/6] Building merged concept bank"
(
  cd "$GI_ML_DIR"
  $JS_RUNNER ./src/cli/build/run-build-discovered-concept-bank.ts \
    --inputs "$INPUTS" \
    --bank-version "$MERGED_BANK_VERSION" \
    --output "$DISCOVERED_BANK_OUTPUT"
)

echo "==> [3/6] Building concept targets"
(
  cd "$PY_DIR"
  python -m gitcg_ml.cli.build_concept_targets \
    --dataset "$DATASET_INPUT" \
    --concept-bank "$DISCOVERED_BANK_OUTPUT" \
    --output "$CONCEPT_TARGETS_OUTPUT"
)

echo "==> [4/6] Training concept model"
(
  cd "$PY_DIR"
  python -m gitcg_ml.cli.train_concept_model \
    --dataset "$DATASET_INPUT" \
    --concept-bank "$DISCOVERED_BANK_OUTPUT" \
    --concept-targets "$CONCEPT_TARGETS_OUTPUT" \
    --output "$CONCEPT_MODEL_OUTPUT" \
    --epochs "$EPOCHS_CONCEPT" \
    --learning-rate "$LEARNING_RATE" \
    --l2 "$L2" \
    --top-features "$TOP_FEATURES"
)

echo "==> [5/6] Training slot-linear ranker"
(
  cd "$PY_DIR"
  python -m gitcg_ml.cli.train_slot_linear_ranker \
    --input "$DATASET_INPUT" \
    --output "$RANKER_ARTIFACT_OUTPUT" \
    --epochs "$EPOCHS_RANKER" \
    --learning-rate "$LEARNING_RATE" \
    --l2 "$L2" \
    --top-tags "$TOP_TAGS" \
    --top-candidate-slots "$TOP_CANDIDATE_SLOTS" \
    --top-query-slots "$TOP_QUERY_SLOTS"
)

echo "==> [6/6] Evaluating ranker"
(
  cd "$GI_ML_DIR"
  $JS_RUNNER ./src/cli/evaluate/run-evaluate-slot-linear-ranker.ts \
    --dataset "$DATASET_INPUT" \
    --artifact "$RANKER_ARTIFACT_OUTPUT" \
    --output "$RANKER_EVAL_OUTPUT"
)

echo "Done."
echo "Preset: $TRAIN_PRESET"
echo "Concept bank: $DISCOVERED_BANK_OUTPUT"
echo "Concept targets: $CONCEPT_TARGETS_OUTPUT"
echo "Concept model: $CONCEPT_MODEL_OUTPUT"
echo "Ranker artifact: $RANKER_ARTIFACT_OUTPUT"
echo "Ranker evaluation: $RANKER_EVAL_OUTPUT"
