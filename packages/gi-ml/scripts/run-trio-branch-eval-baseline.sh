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
GI_AGENT_DIR="$REPO_DIR/packages/gi-agent"
GI_ML_DIR="$REPO_DIR/packages/gi-ml"

# Adjustable Parameters
RUN_LABEL="${RUN_LABEL:-trio-branch-eval-baseline}"
TRIO_DECK_PATH="${TRIO_DECK_PATH:-$GI_AGENT_DIR/trio_deck.txt}"
# JS CLI runner (default: pnpm exec gnx, wraps tsx).
# Override with: JS_RUNNER="bun" or any custom command.
JS_RUNNER="${JS_RUNNER:-pnpm exec gnx}"

POLICY_KIND="${POLICY_KIND:-baseline}"
WEIGHTS_PATH="${WEIGHTS_PATH:-$GI_AGENT_DIR/output/weights.iteration.json}"
END_TURN_PENALTY="${END_TURN_PENALTY:-5}"
LEARNED_SCORE_SCALE="${LEARNED_SCORE_SCALE:-10}"
PRIOR_MODE="${PRIOR_MODE:-none}"

INCLUDE_MIRRORS="${INCLUDE_MIRRORS:-1}"
INCLUDE_REVERSE="${INCLUDE_REVERSE:-0}"
MATCHUP_FILTER_REGEX="${MATCHUP_FILTER_REGEX:-.*}"

RUN_BENCHMARK="${RUN_BENCHMARK:-1}"
RUN_BRANCH_EVAL="${RUN_BRANCH_EVAL:-1}"
RUN_GI_ML_PIPELINE="${RUN_GI_ML_PIPELINE:-1}"

BENCHMARK_GAMES="${BENCHMARK_GAMES:-10}"
BENCHMARK_CONCURRENCY="${BENCHMARK_CONCURRENCY:-1}"
SAMPLE_LOGS_PER_MATCHUP="${SAMPLE_LOGS_PER_MATCHUP:-10}"

BRANCH_SAMPLE_COUNT="${BRANCH_SAMPLE_COUNT:-10}"
BRANCH_MIN_LEGAL_ACTIONS="${BRANCH_MIN_LEGAL_ACTIONS:-3}"
BRANCH_MAX_BRANCHES="${BRANCH_MAX_BRANCHES:-4}"
BRANCH_CONTINUATION_GAMES="${BRANCH_CONTINUATION_GAMES:-5}"

TOP_TAGS="${TOP_TAGS:-32}"
TOP_CANDIDATE_SLOTS="${TOP_CANDIDATE_SLOTS:-24}"

RUN_DIR="${RUN_DIR:-$GI_ML_DIR/output/$RUN_LABEL}"
GENERATED_DIR="$RUN_DIR/generated"
BRANCH_CONFIG_DIR="$GENERATED_DIR/branch-eval"
BENCHMARK_CONFIG_PATH="$GENERATED_DIR/benchmark.trio.json"
MATCHUP_MANIFEST_PATH="$GENERATED_DIR/matchups.tsv"
BENCHMARK_RESULT_PATH="$RUN_DIR/benchmark-result.json"
BENCHMARK_MARKDOWN_PATH="$RUN_DIR/benchmark-report.md"
REPLAY_SAMPLES_DIR="$RUN_DIR/replay-samples"
BRANCH_EVAL_OUTPUT_DIR="$RUN_DIR/branch-eval"
PIPELINE_OUTPUT_DIR="$RUN_DIR/pipeline"
SUMMARY_PATH="$RUN_DIR/summary.json"
SETTINGS_PATH="$GENERATED_DIR/run-settings.json"

mkdir -p "$GENERATED_DIR" "$BRANCH_CONFIG_DIR" "$REPLAY_SAMPLES_DIR" "$BRANCH_EVAL_OUTPUT_DIR" "$PIPELINE_OUTPUT_DIR"

if [[ "$POLICY_KIND" != "baseline" && "$POLICY_KIND" != "evaluator" ]]; then
  echo "Unsupported POLICY_KIND: $POLICY_KIND" >&2
  exit 1
fi

if [[ "$POLICY_KIND" == "evaluator" && ! -f "$WEIGHTS_PATH" ]]; then
  echo "WEIGHTS_PATH does not exist: $WEIGHTS_PATH" >&2
  exit 1
fi

cat > "$SETTINGS_PATH" <<EOF
{
  "trioDeckPath": "$TRIO_DECK_PATH",
  "policyKind": "$POLICY_KIND",
  "weightsPath": "$WEIGHTS_PATH",
  "endTurnPenalty": $END_TURN_PENALTY,
  "learnedScoreScale": $LEARNED_SCORE_SCALE,
  "priorMode": "$PRIOR_MODE",
  "includeMirrors": $INCLUDE_MIRRORS,
  "includeReverse": $INCLUDE_REVERSE,
  "benchmarkGames": $BENCHMARK_GAMES,
  "branchSampleCount": $BRANCH_SAMPLE_COUNT,
  "branchMinLegalActions": $BRANCH_MIN_LEGAL_ACTIONS,
  "branchMaxBranches": $BRANCH_MAX_BRANCHES,
  "branchContinuationGames": $BRANCH_CONTINUATION_GAMES,
  "benchmarkConfigPath": "$BENCHMARK_CONFIG_PATH",
  "matchupManifestPath": "$MATCHUP_MANIFEST_PATH",
  "branchConfigDir": "$BRANCH_CONFIG_DIR",
  "replaySamplesDir": "$REPLAY_SAMPLES_DIR",
  "branchEvalOutputDir": "$BRANCH_EVAL_OUTPUT_DIR",
  "pipelineOutputDir": "$PIPELINE_OUTPUT_DIR"
}
EOF

pnpm exec gnx "$SCRIPT_DIR/lib/generate-trio-benchmark-config.ts" "$SETTINGS_PATH"

echo "Generated benchmark config: $BENCHMARK_CONFIG_PATH"
echo "Generated matchup manifest: $MATCHUP_MANIFEST_PATH"

if [[ "$RUN_BENCHMARK" == "1" ]]; then
  echo "==> Running benchmark with sample logs"
  (
    cd "$GI_AGENT_DIR"
    $JS_RUNNER ./src/evaluation/benchmark/cli/run-benchmark.ts \
      "$BENCHMARK_CONFIG_PATH" \
      --output "$BENCHMARK_RESULT_PATH" \
      --markdown "$BENCHMARK_MARKDOWN_PATH" \
      --concurrency "$BENCHMARK_CONCURRENCY" \
      --sample-logs-dir "$REPLAY_SAMPLES_DIR" \
      --sample-logs-per-matchup "$SAMPLE_LOGS_PER_MATCHUP"
  )
fi

tail_manifest() {
  tail -n +2 "$MATCHUP_MANIFEST_PATH"
}

while IFS=$'\t' read -r matchup_id branch_config_path branch_output_path dataset_output_path artifact_output_path evaluation_output_path; do
  [[ -n "$matchup_id" ]] || continue
  if ! [[ "$matchup_id" =~ $MATCHUP_FILTER_REGEX ]]; then
    continue
  fi

  if [[ "$RUN_BRANCH_EVAL" == "1" ]]; then
    if [[ ! -d "$REPLAY_SAMPLES_DIR/$matchup_id" ]]; then
      echo "Missing replay samples for matchup $matchup_id: $REPLAY_SAMPLES_DIR/$matchup_id" >&2
      exit 1
    fi
    echo "==> Running branch-eval for $matchup_id"
    (
      cd "$GI_AGENT_DIR"
      $JS_RUNNER ./src/evaluation/branch-eval/cli/run-branch-eval.ts "$branch_config_path"
    )
  fi

  if [[ "$RUN_GI_ML_PIPELINE" == "1" ]]; then
    if [[ ! -f "$branch_output_path" ]]; then
      echo "Missing branch-eval report for matchup $matchup_id: $branch_output_path" >&2
      exit 1
    fi
    echo "==> Running gi-ml pipeline for $matchup_id"
    (
      cd "$GI_ML_DIR"
      $JS_RUNNER ./src/cli/pipeline/run-build-branch-eval-baseline-pipeline.ts \
        --input "$branch_output_path" \
        --dataset-output "$dataset_output_path" \
        --artifact-output "$artifact_output_path" \
        --evaluation-output "$evaluation_output_path" \
        --top-tags "$TOP_TAGS" \
        --top-candidate-slots "$TOP_CANDIDATE_SLOTS"
    )
  fi
done < <(tail_manifest)

pnpm exec gnx "$SCRIPT_DIR/lib/summarize-trio-results.ts" "$MATCHUP_MANIFEST_PATH" "$SUMMARY_PATH" "$MATCHUP_FILTER_REGEX"

echo "Done."
echo "Summary: $SUMMARY_PATH"
