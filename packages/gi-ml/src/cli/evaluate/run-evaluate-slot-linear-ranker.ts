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
import type { MlRankingDataset } from "../../contracts/index.js"
import { readJsonFile, resolveCliPath, writeJsonFile } from "../../io/index.js"
import { readSlotLinearRankerArtifact } from "../../ranker/json.js"
import { evaluateRankingDataset } from "../../ranker/evaluate.js"
import { SlotLinearRanker } from "../../ranker/slot-linear-ranker.js"

async function main() {
  const { values } = parseArgs({
    options: {
      dataset: { type: "string", default: "" },
      artifact: { type: "string", default: "" },
      output: { type: "string", default: "" },
    },
    strict: false,
  })

  const datasetPath = values.dataset as string
  const artifactPath = values.artifact as string
  if (!datasetPath || !artifactPath) {
    throw new Error("dataset and artifact are required")
  }

  const dataset = await readJsonFile<MlRankingDataset>(resolveCliPath(datasetPath))
  const artifact = await readSlotLinearRankerArtifact(resolveCliPath(artifactPath))
  const evaluation = await evaluateRankingDataset(
    new SlotLinearRanker(artifact),
    dataset,
  )

  if (values.output) {
    const outputPath = resolveCliPath(values.output as string)
    await writeJsonFile(outputPath, evaluation)
    console.log(`Ranking evaluation written: ${outputPath}`)
    return
  }

  console.log(JSON.stringify(evaluation, null, 2))
}

main().catch((error) => {
  console.error("run-evaluate-slot-linear-ranker fatal error:", error)
  process.exit(1)
})
