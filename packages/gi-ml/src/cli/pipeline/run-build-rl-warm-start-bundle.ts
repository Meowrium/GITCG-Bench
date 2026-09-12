// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { parseArgs } from "node:util"
import { join, resolve } from "node:path"
import { loadRlDatasetInput } from "../../datasets/rl-input.js"
import { buildRankingDatasetFromRlDataset } from "../../datasets/rl.js"
import { buildValueDatasetFromRlDataset } from "../../datasets/rl-value.js"
import { writeJsonFile, writeRankingDatasetFile, writeValueDatasetFile } from "../../io/index.js"
import { buildSlotLinearArtifactFromDataset } from "../../ranker/build-slot-linear-artifact.js"
import { evaluateRankingDataset } from "../../ranker/evaluate.js"
import { SlotLinearRanker } from "../../ranker/slot-linear-ranker.js"
import { buildLinearValueArtifactFromDataset } from "../../value/build-linear-value-artifact.js"
import { evaluateValueDataset } from "../../value/evaluate.js"

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", default: "" },
      "output-dir": { type: "string", default: "./output/rl-warm-start-bundle" },
      prefix: { type: "string", default: "rl_smoke" },
      "dataset-id": { type: "string", default: "" },
      version: { type: "string", default: "" },
      "top-tags": { type: "string", default: "32" },
      "top-candidate-slots": { type: "string", default: "24" },
      "top-features": { type: "string", default: "32" },
    },
    strict: false,
  })

  const inputPath = values.input as string
  if (!inputPath) {
    throw new Error("input is required")
  }

  const outputDir = resolve(values["output-dir"] as string)
  const prefix = (values.prefix as string) || "rl_smoke"
  const datasetId = (values["dataset-id"] as string) || undefined
  const version = (values.version as string) || prefix

  // ── Phase 1: Ranking ──
  console.log("[Phase 1/2] Loading RL dataset for ranking...")
  let rlDataset = await loadRlDatasetInput(resolve(inputPath))
  console.log(`  Loaded ${rlDataset.sample_count} samples from ${rlDataset.source_capture_count} captures`)

  console.log("  Building ranking dataset...")
  const rankingDataset = buildRankingDatasetFromRlDataset(rlDataset, {
    datasetId: datasetId ? `${datasetId}_ranking` : undefined,
  })
  console.log(`  Ranking dataset: ${rankingDataset.query_groups.length} query groups`)

  // Free RL dataset after ranking is built — saves ~2.5 GB
  rlDataset = null as any
  if (typeof globalThis.gc === "function") {
    globalThis.gc()
  }

  const rankingArtifact = buildSlotLinearArtifactFromDataset(rankingDataset, {
    artifactVersion: `${version}_ranker`,
    topTagCount: Number(values["top-tags"]),
    topCandidateNumericSlotCount: Number(values["top-candidate-slots"]),
  })
  console.log("  Evaluating ranking artifact...")
  const rankingEvaluation = await evaluateRankingDataset(
    new SlotLinearRanker(rankingArtifact),
    rankingDataset,
  )

  // Write ranking outputs (streaming) and free ranking dataset
  console.log("  Writing ranking dataset (streaming)...")
  const rankingDatasetPath = await writeRankingDatasetFile(
    join(outputDir, `${prefix}.ranking-dataset.json`), rankingDataset,
  )
  // Free ranking dataset from memory
  ;(rankingDataset as { query_groups: unknown[] }).query_groups = []

  const rankingArtifactPath = await writeJsonFile(join(outputDir, `${prefix}.ranker-artifact.json`), rankingArtifact)
  const rankingEvalPath = await writeJsonFile(join(outputDir, `${prefix}.ranker-eval.json`), rankingEvaluation)

  // ── Phase 2: Value ──
  console.log("[Phase 2/2] Loading RL dataset for value...")
  rlDataset = await loadRlDatasetInput(resolve(inputPath))

  console.log("  Building value dataset...")
  const valueDataset = buildValueDatasetFromRlDataset(rlDataset, {
    datasetId: datasetId ? `${datasetId}_value` : undefined,
  })
  console.log(`  Value dataset: ${valueDataset.samples.length} samples`)

  const valueArtifact = buildLinearValueArtifactFromDataset(valueDataset, {
    artifactVersion: `${version}_value`,
    topFeatureCount: Number(values["top-features"]),
  })
  const valueEvaluation = evaluateValueDataset(valueArtifact, valueDataset)

  // Write value outputs (streaming) and free value dataset
  console.log("  Writing value dataset (streaming)...")
  const valueDatasetPath = await writeValueDatasetFile(
    join(outputDir, `${prefix}.value-dataset.json`), valueDataset,
  )
  // Free value dataset from memory
  ;(valueDataset as { samples: unknown[] }).samples = []

  const valueArtifactPath = await writeJsonFile(join(outputDir, `${prefix}.value-artifact.json`), valueArtifact)
  const valueEvalPath = await writeJsonFile(join(outputDir, `${prefix}.value-eval.json`), valueEvaluation)

  const outputs = {
    ranking_dataset: rankingDatasetPath,
    ranking_artifact: rankingArtifactPath,
    ranking_evaluation: rankingEvalPath,
    value_dataset: valueDatasetPath,
    value_artifact: valueArtifactPath,
    value_evaluation: valueEvalPath,
  }

  const bundle = {
    bundle_version: "rl_warm_start_bundle.v1",
    created_at: new Date().toISOString(),
    source_dataset: resolve(inputPath),
    outputs,
    metrics: {
      ranking: {
        query_count: rankingEvaluation.query_count,
        pairwise_support_rate: rankingEvaluation.pairwise_support_rate,
        top1_not_contradicted_rate: rankingEvaluation.top1_not_contradicted_rate,
      },
      value: {
        sample_count: valueEvaluation.sample_count,
        mae: valueEvaluation.mae,
        rmse: valueEvaluation.rmse,
      },
    },
    versions: {
      ranker_artifact_version: rankingArtifact.artifact_version,
      value_artifact_version: valueArtifact.artifact_version,
    },
  }
  const bundlePath = await writeJsonFile(join(outputDir, `${prefix}.bundle.json`), bundle)

  console.log(`RL warm-start bundle written: ${bundlePath}`)
  console.log(`ranking_query_count=${rankingEvaluation.query_count}`)
  console.log(`pairwise_support_rate=${rankingEvaluation.pairwise_support_rate ?? "null"}`)
  console.log(`top1_not_contradicted_rate=${rankingEvaluation.top1_not_contradicted_rate ?? "null"}`)
  console.log(`value_sample_count=${valueEvaluation.sample_count}`)
  console.log(`value_mae=${valueEvaluation.mae ?? "null"}`)
  console.log(`value_rmse=${valueEvaluation.rmse ?? "null"}`)
}

main().catch((error) => {
  console.error("run-build-rl-warm-start-bundle fatal error:", error)
  process.exit(1)
})
