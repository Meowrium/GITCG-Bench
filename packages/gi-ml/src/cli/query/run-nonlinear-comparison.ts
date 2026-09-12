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
import { writeJsonFile } from "../../io/index.js"
import { buildLinearValueArtifactFromDataset } from "../../value/build-linear-value-artifact.js"
import { buildSlotLinearArtifactFromDataset } from "../../ranker/build-slot-linear-artifact.js"
import { evaluateValueDataset } from "../../value/evaluate.js"
import { evaluateRankingDataset } from "../../ranker/evaluate.js"
import { SlotLinearRanker } from "../../ranker/slot-linear-ranker.js"
import {
  buildGbdtValueArtifactFromDataset,
  buildMlpValueArtifactFromDataset,
} from "../../value/build-nonlinear-value-artifact.js"
import {
  evaluateGbdtValueDataset,
  evaluateMlpValueDataset,
} from "../../value/evaluate-nonlinear.js"

interface ComparisonResult {
  model: string
  artifact_type: string
  sample_count: number
  mae: number | null
  rmse: number | null
  training_mae?: number
  training_rmse?: number
}

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", default: "" },
      "output-dir": { type: "string", default: "./output/nonlinear-comparison" },
      prefix: { type: "string", default: "cmp" },
      "gbdt-estimators": { type: "string", default: "60" },
      "gbdt-depth": { type: "string", default: "4" },
      "gbdt-lr": { type: "string", default: "1" },
      "mlp-hidden": { type: "string", default: "32,16" },
      "mlp-epochs": { type: "string", default: "80" },
      "mlp-lr": { type: "string", default: "0.001" },
      "top-features": { type: "string", default: "48" },
    },
    strict: false,
  })

  const inputPath = values.input as string
  if (!inputPath) {
    throw new Error("Usage: pnpm exec gnx ... --input <rl-dataset.json>")
  }

  const outputDir = resolve(values["output-dir"] as string)
  const prefix = values.prefix as string
  const topFeatures = Number(values["top-features"])
  const gbdtEstimators = Number(values["gbdt-estimators"])
  const gbdtDepth = Number(values["gbdt-depth"])
  const gbdtLr = Number(values["gbdt-lr"])
  const mlpHidden = (values["mlp-hidden"] as string).split(",").map(Number)
  const mlpEpochs = Number(values["mlp-epochs"])
  const mlpLr = Number(values["mlp-lr"])

  console.log("Loading RL dataset...")
  const rlDataset = await loadRlDatasetInput(resolve(inputPath))

  console.log("Building value dataset...")
  const valueDataset = buildValueDatasetFromRlDataset(rlDataset, {})
  console.log(`  samples=${valueDataset.samples.length}`)

  console.log("Building ranking dataset...")
  const rankingDataset = buildRankingDatasetFromRlDataset(rlDataset, {})
  console.log(`  query_groups=${rankingDataset.query_groups.length}`)

  const comparison: ComparisonResult[] = []

  // ======================== 1. Linear Value ========================
  console.log("\n[1/5] Training Linear Value model...")
  const linearValue = buildLinearValueArtifactFromDataset(valueDataset, {
    artifactVersion: `${prefix}_linear_value`,
    topFeatureCount: topFeatures,
  })
  const linearValueEval = evaluateValueDataset(linearValue, valueDataset)
  await writeJsonFile(join(outputDir, `${prefix}.linear-value-artifact.json`), linearValue)
  comparison.push({
    model: "Linear Value",
    artifact_type: linearValue.artifact_type,
    sample_count: linearValueEval.sample_count,
    mae: linearValueEval.mae,
    rmse: linearValueEval.rmse,
  })
  console.log(`  MAE=${linearValueEval.mae?.toFixed(4)}  RMSE=${linearValueEval.rmse?.toFixed(4)}`)

  // ======================== 2. GBDT Value ========================
  console.log("\n[2/5] Training GBDT Value model...")
  const gbdtValue = buildGbdtValueArtifactFromDataset(valueDataset, {
    artifactVersion: `${prefix}_gbdt_value`,
    nEstimators: gbdtEstimators,
    maxDepth: gbdtDepth,
    learningRate: gbdtLr,
    topFeatureCount: topFeatures,
  })
  const gbdtValueEval = evaluateGbdtValueDataset(gbdtValue, valueDataset)
  await writeJsonFile(join(outputDir, `${prefix}.gbdt-value-artifact.json`), gbdtValue)
  await writeJsonFile(join(outputDir, `${prefix}.gbdt-value-eval.json`), {
    ...gbdtValueEval,
    diagnostics: undefined,
  })
  comparison.push({
    model: "GBDT Value",
    artifact_type: gbdtValue.artifact_type,
    sample_count: gbdtValueEval.sample_count,
    mae: gbdtValueEval.mae,
    rmse: gbdtValueEval.rmse,
    training_mae: gbdtValue.metadata.training_mae,
    training_rmse: gbdtValue.metadata.training_rmse,
  })
  console.log(`  MAE=${gbdtValueEval.mae?.toFixed(4)}  RMSE=${gbdtValueEval.rmse?.toFixed(4)}`)
  console.log(`  trees=${gbdtValue.trees.length}  depth=${gbdtDepth}  lr=${gbdtLr}`)

  // ======================== 3. MLP Value ========================
  console.log("\n[3/5] Training MLP Value model...")
  const mlpValue = buildMlpValueArtifactFromDataset(valueDataset, {
    artifactVersion: `${prefix}_mlp_value`,
    hiddenDims: mlpHidden,
    epochs: mlpEpochs,
    learningRate: mlpLr,
    topFeatureCount: topFeatures,
  })
  const mlpValueEval = evaluateMlpValueDataset(mlpValue, valueDataset)
  await writeJsonFile(join(outputDir, `${prefix}.mlp-value-artifact.json`), mlpValue)
  await writeJsonFile(join(outputDir, `${prefix}.mlp-value-eval.json`), {
    ...mlpValueEval,
    diagnostics: undefined,
  })
  comparison.push({
    model: "MLP Value",
    artifact_type: mlpValue.artifact_type,
    sample_count: mlpValueEval.sample_count,
    mae: mlpValueEval.mae,
    rmse: mlpValueEval.rmse,
    training_mae: mlpValue.metadata.training_mae,
    training_rmse: mlpValue.metadata.training_rmse,
  })
  console.log(`  MAE=${mlpValueEval.mae?.toFixed(4)}  RMSE=${mlpValueEval.rmse?.toFixed(4)}`)
  console.log(`  hidden=${mlpHidden.join("×")}  epochs=${mlpEpochs}`)

  // ======================== 4. Slot-Linear Ranker ========================
  console.log("\n[4/5] Training Slot-Linear Ranker...")
  const slotLinearRanker = buildSlotLinearArtifactFromDataset(rankingDataset, {
    artifactVersion: `${prefix}_slot_linear_ranker`,
  })
  const slotLinearRankerEval = await evaluateRankingDataset(
    new SlotLinearRanker(slotLinearRanker),
    rankingDataset,
  )
  await writeJsonFile(join(outputDir, `${prefix}.slot-linear-ranker-artifact.json`), slotLinearRanker)
  console.log(`  pairwise_support=${slotLinearRankerEval.pairwise_support_rate?.toFixed(4)}`)
  console.log(`  top1_not_contradicted=${slotLinearRankerEval.top1_not_contradicted_rate?.toFixed(4)}`)

  // ======================== 5. Summary ========================
  console.log("\n" + "=".repeat(70))
  console.log("VALUE MODEL COMPARISON")
  console.log("=".repeat(70))
  console.log(
    padRight("Model", 20) +
    padRight("MAE", 12) +
    padRight("RMSE", 12) +
    padRight("Improvement", 15),
  )
  console.log("-".repeat(59))

  const baselineMae = comparison[0].mae ?? 1
  for (const entry of comparison) {
    const maeStr = entry.mae?.toFixed(4) ?? "N/A"
    const rmseStr = entry.rmse?.toFixed(4) ?? "N/A"
    const improvement = entry.mae != null
      ? ((1 - entry.mae / baselineMae) * 100).toFixed(1) + "%"
      : "N/A"
    console.log(
      padRight(entry.model, 20) +
      padRight(maeStr, 12) +
      padRight(rmseStr, 12) +
      padRight(improvement, 15),
    )
  }

  console.log("\nRANKER METRICS")
  console.log("-".repeat(50))
  console.log(`Slot-Linear pairwise_support_rate: ${slotLinearRankerEval.pairwise_support_rate?.toFixed(4)}`)
  console.log(`Slot-Linear top1_not_contradicted: ${slotLinearRankerEval.top1_not_contradicted_rate?.toFixed(4)}`)

  // Save comparison summary
  const summary = {
    created_at: new Date().toISOString(),
    source_dataset: resolve(inputPath),
    value_comparison: comparison,
    ranker: {
      slot_linear: {
        pairwise_support_rate: slotLinearRankerEval.pairwise_support_rate,
        top1_not_contradicted_rate: slotLinearRankerEval.top1_not_contradicted_rate,
      },
    },
    config: {
      gbdt: { n_estimators: gbdtEstimators, max_depth: gbdtDepth, learning_rate: gbdtLr },
      mlp: { hidden_dims: mlpHidden, epochs: mlpEpochs, learning_rate: mlpLr },
      top_features: topFeatures,
    },
  }
  await writeJsonFile(join(outputDir, `${prefix}.comparison-summary.json`), summary)
  console.log(`\nComparison summary written to: ${join(outputDir, `${prefix}.comparison-summary.json`)}`)
}

function padRight(str: string, len: number): string {
  return str.padEnd(len)
}

main().catch((error) => {
  console.error("run-nonlinear-comparison fatal error:", error)
  process.exit(1)
})
