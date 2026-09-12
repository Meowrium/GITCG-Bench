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
import { resolve } from "node:path"
import { loadRlDatasetInput } from "../../datasets/rl-input.js"
import { buildValueDatasetFromRlDataset } from "../../datasets/rl-value.js"
import { writeJsonFile } from "../../io/index.js"
import { buildLinearValueArtifactFromDataset } from "../../value/build-linear-value-artifact.js"
import { evaluateValueDataset } from "../../value/evaluate.js"

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", default: "" },
      "dataset-output": { type: "string", default: "./output/rl-value-dataset.json" },
      "artifact-output": { type: "string", default: "./output/rl-linear-value-artifact.json" },
      "evaluation-output": { type: "string", default: "./output/rl-linear-value-eval.json" },
      "dataset-id": { type: "string", default: "" },
      version: { type: "string", default: "" },
      "include-unknown-outcome": { type: "boolean", default: false },
      "top-features": { type: "string", default: "32" },
    },
    strict: false,
  })

  const inputPath = values.input as string
  if (!inputPath) {
    throw new Error("input is required")
  }

  const rlDataset = await loadRlDatasetInput(resolve(inputPath))
  const valueDataset = buildValueDatasetFromRlDataset(rlDataset, {
    datasetId: (values["dataset-id"] as string) || undefined,
    includeUnknownOutcome: Boolean(values["include-unknown-outcome"]),
  })
  const datasetPath = await writeJsonFile(values["dataset-output"] as string, valueDataset)

  const artifact = buildLinearValueArtifactFromDataset(valueDataset, {
    artifactVersion: (values.version as string) || undefined,
    topFeatureCount: Number(values["top-features"]),
  })
  const artifactPath = await writeJsonFile(values["artifact-output"] as string, artifact)

  const evaluation = evaluateValueDataset(artifact, valueDataset)
  const evaluationPath = await writeJsonFile(values["evaluation-output"] as string, evaluation)

  console.log(`RL value dataset written: ${datasetPath}`)
  console.log(`sample_count=${valueDataset.samples.length}`)
  console.log(`Linear value artifact written: ${artifactPath}`)
  console.log(`artifact_version=${artifact.artifact_version}`)
  console.log(`Linear value evaluation written: ${evaluationPath}`)
  console.log(`mae=${evaluation.mae ?? "null"}`)
  console.log(`rmse=${evaluation.rmse ?? "null"}`)
}

main().catch((error) => {
  console.error("run-build-rl-value-warm-start-pipeline fatal error:", error)
  process.exit(1)
})
