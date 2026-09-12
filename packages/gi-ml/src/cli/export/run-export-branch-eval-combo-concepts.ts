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
import type { MlRankingDataset } from "../../contracts/index.js"
import { extractComboConceptHypothesesFromBranchEvalDataset } from "../../concept-discovery/index.js"
import { readJsonFile, writeJsonFile } from "../../io/index.js"

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", default: "" },
      output: { type: "string", default: "./output/gi-ml/branch-eval-combo-concepts.json" },
      "min-support": { type: "string", default: "2" },
      "min-mean-confidence": { type: "string", default: "0.15" },
      "min-combo-steps": { type: "string", default: "2" },
      "max-combo-steps": { type: "string", default: "4" },
      "max-point-gap": { type: "string", default: "12" },
    },
    strict: false,
  })

  const inputPath = values.input as string
  if (!inputPath) {
    throw new Error("input is required")
  }

  const dataset = await readJsonFile<MlRankingDataset>(resolve(inputPath))
  const concepts = extractComboConceptHypothesesFromBranchEvalDataset(dataset, {
    minSupport: Number(values["min-support"]),
    minMeanConfidence: Number(values["min-mean-confidence"]),
    minComboSteps: Number(values["min-combo-steps"]),
    maxComboSteps: Number(values["max-combo-steps"]),
    maxPointGap: Number(values["max-point-gap"]),
  })

  const outputPath = await writeJsonFile(values.output as string, {
    generated_at: new Date().toISOString(),
    source: "branch_eval_dataset",
    dataset_id: dataset.dataset_id,
    concept_count: concepts.length,
    concepts,
  })
  console.log(`Branch-eval combo concepts written: ${outputPath}`)
  console.log(`concepts=${concepts.length}`)
}

main().catch((error) => {
  console.error("run-export-branch-eval-combo-concepts fatal error:", error)
  process.exit(1)
})
