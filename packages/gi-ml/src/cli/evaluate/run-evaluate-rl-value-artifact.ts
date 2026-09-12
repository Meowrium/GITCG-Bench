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
import type { MlValueDataset } from "../../contracts/index.js"
import { readJsonFile, resolveCliPath, writeJsonFile } from "../../io/index.js"
import { evaluateValueDataset } from "../../value/evaluate.js"
import { readLinearValueArtifact } from "../../value/json.js"

async function main() {
  const { values } = parseArgs({
    options: {
      dataset: { type: "string", default: "" },
      artifact: { type: "string", default: "" },
      output: { type: "string", default: "./output/rl-linear-value-eval.json" },
    },
    strict: false,
  })

  const datasetPath = values.dataset as string
  const artifactPath = values.artifact as string
  if (!datasetPath || !artifactPath) {
    throw new Error("dataset and artifact are required")
  }

  const [dataset, artifact] = await Promise.all([
    readJsonFile<MlValueDataset>(resolveCliPath(datasetPath)),
    readLinearValueArtifact(resolveCliPath(artifactPath)),
  ])
  const evaluation = evaluateValueDataset(artifact, dataset)
  const outputPath = await writeJsonFile(resolveCliPath(values.output as string), evaluation)

  console.log(`RL value evaluation written: ${outputPath}`)
  console.log(`sample_count=${evaluation.sample_count}`)
  console.log(`mae=${evaluation.mae ?? "null"}`)
  console.log(`rmse=${evaluation.rmse ?? "null"}`)
}

main().catch((error) => {
  console.error("run-evaluate-rl-value-artifact fatal error:", error)
  process.exit(1)
})
