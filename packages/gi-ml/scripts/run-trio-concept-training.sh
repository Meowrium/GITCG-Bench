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

# JS CLI runner (default: pnpm exec gnx, wraps tsx).
# Override with: JS_RUNNER="bun" or any custom command.

RUN_LABEL="${RUN_LABEL:-trio-concept-training}"
BENCHMARK_RUN_LABEL="${BENCHMARK_RUN_LABEL:-${RUN_LABEL}-trio}"
CONCEPT_RUN_LABEL="${CONCEPT_RUN_LABEL:-${RUN_LABEL}-concept}"
JS_RUNNER="${JS_RUNNER:-pnpm exec gnx}"
INSTALL_ENV="${INSTALL_ENV:-0}"
TRAIN_PRESET="${TRAIN_PRESET:-laptop}"
COMBAT_CONCEPTS_INPUT="${COMBAT_CONCEPTS_INPUT:-}"
COMBO_CONCEPTS_INPUT="${COMBO_CONCEPTS_INPUT:-}"
TREE_LAKE_INPUT="${TREE_LAKE_INPUT:-$REPO_DIR/packages/gi-agent/output/combat-windows/tree-lake.sqlite}"
AUTO_EXPORT_COMBO_CONCEPTS="${AUTO_EXPORT_COMBO_CONCEPTS:-1}"
AUTO_EXPORT_BRANCH_EVAL_COMBO_CONCEPTS="${AUTO_EXPORT_BRANCH_EVAL_COMBO_CONCEPTS:-1}"
GENERATE_ONLY="${GENERATE_ONLY:-0}"

TRIO_RUN_DIR="$GI_ML_DIR/output/$BENCHMARK_RUN_LABEL"
MERGED_DATASET_OUTPUT="$TRIO_RUN_DIR/merged-dataset.json"

# Path passthrough (was a wslpath shim for Windows-side bun.exe; pnpm/tsx runs in WSL natively).
to_runner_path() {
  printf '%s\n' "$1"
}

echo "==> [1/3] Running trio benchmark / branch-eval / baseline export"
RUN_LABEL="$BENCHMARK_RUN_LABEL" \
RUN_BENCHMARK="${RUN_BENCHMARK:-1}" \
RUN_BRANCH_EVAL="${RUN_BRANCH_EVAL:-1}" \
RUN_GI_ML_PIPELINE=1 \
  bash "$SCRIPT_DIR/run-trio-branch-eval-baseline.sh"

echo "==> [2/3] Merging per-matchup datasets"
mapfile -t dataset_files < <(find "$TRIO_RUN_DIR/pipeline" -type f -name "*.dataset.json" | sort)
if [[ "${#dataset_files[@]}" -eq 0 ]]; then
  echo "No per-matchup datasets found under $TRIO_RUN_DIR/pipeline" >&2
  exit 1
fi

joined_inputs=""
for dataset in "${dataset_files[@]}"; do
  runner_path="$(to_runner_path "$dataset")"
  if [[ -z "$joined_inputs" ]]; then
    joined_inputs="$runner_path"
  else
    joined_inputs="$joined_inputs,$bun_path"
  fi
done

$JS_RUNNER "$(to_runner_path "$GI_ML_DIR/src/cli/query/run-merge-ranking-datasets.ts")" \
  --inputs "$joined_inputs" \
  --dataset-id "${BENCHMARK_RUN_LABEL}_merged" \
  --output "$(to_runner_path "$MERGED_DATASET_OUTPUT")"

if [[ "$GENERATE_ONLY" == "1" ]]; then
  echo "GENERATE_ONLY=1 set. Skipping concept training."
  echo "Merged dataset: $MERGED_DATASET_OUTPUT"
  exit 0
fi

echo "==> [3/3] Running concept training on merged dataset"
RUN_LABEL="$CONCEPT_RUN_LABEL" \
INSTALL_ENV="$INSTALL_ENV" \
TRAIN_PRESET="$TRAIN_PRESET" \
DATASET_INPUT="$MERGED_DATASET_OUTPUT" \
COMBAT_CONCEPTS_INPUT="$COMBAT_CONCEPTS_INPUT" \
COMBO_CONCEPTS_INPUT="$COMBO_CONCEPTS_INPUT" \
TREE_LAKE_INPUT="$TREE_LAKE_INPUT" \
AUTO_EXPORT_COMBO_CONCEPTS="$AUTO_EXPORT_COMBO_CONCEPTS" \
AUTO_EXPORT_BRANCH_EVAL_COMBO_CONCEPTS="$AUTO_EXPORT_BRANCH_EVAL_COMBO_CONCEPTS" \
  bash "$SCRIPT_DIR/run-concept-training-pipeline.sh"

echo "Done."
echo "Trio run dir: $TRIO_RUN_DIR"
echo "Merged dataset: $MERGED_DATASET_OUTPUT"
echo "Concept outputs: $GI_ML_DIR/output/$CONCEPT_RUN_LABEL"
