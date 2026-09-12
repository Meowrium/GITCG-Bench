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

/**
 * Standalone GBDT value artifact trainer.
 *
 * Reads an RL dataset, builds a GBDT value artifact, evaluates it,
 * and writes both artifact and evaluation JSON.
 *
 * Usage:
 *   pnpm exec gnx src/cli/run-build-gbdt-value.ts \
 *     --input <rl-dataset.json> \
 *     --output-dir <dir> \
 *     --prefix <name> \
 *     [--estimators 100] [--depth 5] [--lr 0.06] \
 *     [--top-features 48] [--min-leaf 8] [--subsample 0.8]
 */

import { parseArgs } from "node:util"
import { join, resolve } from "node:path"
import { loadRlDatasetInput } from "../../datasets/rl-input.js"
import { buildValueDatasetFromRlDataset } from "../../datasets/rl-value.js"
import { writeJsonFile } from "../../io/index.js"
import { buildGbdtValueArtifactFromDataset } from "../../value/build-nonlinear-value-artifact.js"
import { evaluateGbdtValueDataset } from "../../value/evaluate-nonlinear.js"

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", default: "" },
      "output-dir": { type: "string", default: "./output/gbdt-value" },
      prefix: { type: "string", default: "gbdt" },
      estimators: { type: "string", default: "100" },
      depth: { type: "string", default: "5" },
      lr: { type: "string", default: "0.06" },
      "top-features": { type: "string", default: "48" },
      "min-leaf": { type: "string", default: "8" },
      subsample: { type: "string", default: "0.8" },
    },
    strict: false,
  })

  const inputPath = values.input as string
  if (!inputPath) {
    console.error("Usage: pnpm exec gnx run-build-gbdt-value.ts --input <rl-dataset.json> [options]")
    process.exit(1)
  }

  const outputDir = resolve(values["output-dir"] as string)
  const prefix = values.prefix as string
  const nEstimators = Number(values.estimators)
  const maxDepth = Number(values.depth)
  const learningRate = Number(values.lr)
  const topFeatureCount = Number(values["top-features"])
  const minSamplesLeaf = Number(values["min-leaf"])
  const subsampleRate = Number(values.subsample)

  console.log(`Loading RL dataset from ${inputPath}...`)
  const rlDataset = await loadRlDatasetInput(resolve(inputPath))

  console.log(`Building value dataset...`)
  const valueDataset = buildValueDatasetFromRlDataset(rlDataset)

  console.log(`Training GBDT (estimators=${nEstimators}, depth=${maxDepth}, lr=${learningRate}, features=${topFeatureCount})...`)
  const gbdtArtifact = buildGbdtValueArtifactFromDataset(valueDataset, {
    artifactVersion: `${prefix}_gbdt_value`,
    nEstimators,
    maxDepth,
    learningRate,
    minSamplesLeaf,
    subsampleRate,
    topFeatureCount,
  })

  console.log(`Evaluating...`)
  const evaluation = evaluateGbdtValueDataset(gbdtArtifact, valueDataset)

  const artifactPath = await writeJsonFile(
    join(outputDir, `${prefix}.gbdt-value-artifact.json`),
    gbdtArtifact,
  )
  const evalPath = await writeJsonFile(
    join(outputDir, `${prefix}.gbdt-value-eval.json`),
    evaluation,
  )

  console.log(`\nGBDT Value Training Complete`)
  console.log(`  Artifact: ${artifactPath}`)
  console.log(`  Evaluation: ${evalPath}`)
  console.log(`  Samples: ${evaluation.sample_count}`)
  console.log(`  MAE: ${evaluation.mae?.toFixed(4) ?? "null"}`)
  console.log(`  RMSE: ${evaluation.rmse?.toFixed(4) ?? "null"}`)
  console.log(`  Mean prediction: ${evaluation.mean_prediction?.toFixed(4) ?? "null"}`)
  console.log(`  Mean target: ${evaluation.mean_target?.toFixed(4) ?? "null"}`)
}

main().catch((error) => {
  console.error("run-build-gbdt-value fatal error:", error)
  process.exit(1)
})
