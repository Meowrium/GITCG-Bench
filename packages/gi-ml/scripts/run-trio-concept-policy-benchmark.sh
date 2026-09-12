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

# JS CLI runner (default: pnpm exec gnx, wraps tsx).
# Override with: JS_RUNNER="bun" or any custom command.

RUN_LABEL="${RUN_LABEL:-trio-concept-policy-benchmark}"
CONCEPT_RUN_LABEL="${CONCEPT_RUN_LABEL:-trio-concept-training-concept}"
TRIO_DECK_PATH="${TRIO_DECK_PATH:-$GI_AGENT_DIR/trio_deck.txt}"
JS_RUNNER="${JS_RUNNER:-pnpm exec gnx}"

INCLUDE_MIRRORS="${INCLUDE_MIRRORS:-1}"
INCLUDE_REVERSE="${INCLUDE_REVERSE:-1}"
MATCHUP_FILTER_REGEX="${MATCHUP_FILTER_REGEX:-.*}"
BENCHMARK_GAMES="${BENCHMARK_GAMES:-120}"
BENCHMARK_CONCURRENCY="${BENCHMARK_CONCURRENCY:-1}"
SAMPLE_LOGS_PER_MATCHUP="${SAMPLE_LOGS_PER_MATCHUP:-24}"

END_TURN_PENALTY="${END_TURN_PENALTY:-5}"
GI_ML_USE_BASELINE_TIEBREAKER="${GI_ML_USE_BASELINE_TIEBREAKER:-1}"

RUN_DIR="${RUN_DIR:-$GI_ML_DIR/output/$RUN_LABEL}"
GENERATED_DIR="$RUN_DIR/generated"
BENCHMARK_CONFIG_PATH="$GENERATED_DIR/benchmark.trio.json"
BENCHMARK_RESULT_PATH="$RUN_DIR/benchmark-result.json"
BENCHMARK_MARKDOWN_PATH="$RUN_DIR/benchmark-report.md"
REPLAY_SAMPLES_DIR="$RUN_DIR/replay-samples"
SETTINGS_PATH="$GENERATED_DIR/run-settings.json"

CONCEPT_OUTPUT_DIR="$GI_ML_DIR/output/$CONCEPT_RUN_LABEL"
RANKER_ARTIFACT_PATH="$CONCEPT_OUTPUT_DIR/ranker-artifact.json"
CONCEPT_MODEL_PATH="$CONCEPT_OUTPUT_DIR/concept-model.json"

mkdir -p "$GENERATED_DIR" "$REPLAY_SAMPLES_DIR"

if [[ ! -f "$TRIO_DECK_PATH" ]]; then
  echo "TRIO_DECK_PATH does not exist: $TRIO_DECK_PATH" >&2
  exit 1
fi

if [[ ! -f "$RANKER_ARTIFACT_PATH" ]]; then
  echo "Missing ranker artifact: $RANKER_ARTIFACT_PATH" >&2
  exit 1
fi

if [[ ! -f "$CONCEPT_MODEL_PATH" ]]; then
  echo "Missing concept model: $CONCEPT_MODEL_PATH" >&2
  exit 1
fi

cat > "$SETTINGS_PATH" <<EOF
{
  "trioDeckPath": "$TRIO_DECK_PATH",
  "conceptOutputDir": "$CONCEPT_OUTPUT_DIR",
  "rankerArtifactPath": "$RANKER_ARTIFACT_PATH",
  "conceptModelPath": "$CONCEPT_MODEL_PATH",
  "includeMirrors": $INCLUDE_MIRRORS,
  "includeReverse": $INCLUDE_REVERSE,
  "matchupFilterRegex": "$MATCHUP_FILTER_REGEX",
  "benchmarkGames": $BENCHMARK_GAMES,
  "sampleLogsPerMatchup": $SAMPLE_LOGS_PER_MATCHUP,
  "benchmarkConfigPath": "$BENCHMARK_CONFIG_PATH",
  "benchmarkResultPath": "$BENCHMARK_RESULT_PATH",
  "benchmarkMarkdownPath": "$BENCHMARK_MARKDOWN_PATH",
  "replaySamplesDir": "$REPLAY_SAMPLES_DIR",
  "endTurnPenalty": $END_TURN_PENALTY,
  "useBaselineTieBreaker": $GI_ML_USE_BASELINE_TIEBREAKER
}
EOF

pnpm exec gnx "$SCRIPT_DIR/lib/generate-trio-concept-policy-benchmark-config.ts" "$SETTINGS_PATH"

echo "Generated benchmark config: $BENCHMARK_CONFIG_PATH"

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

echo "Done."
echo "Benchmark result: $BENCHMARK_RESULT_PATH"
echo "Benchmark report: $BENCHMARK_MARKDOWN_PATH"
