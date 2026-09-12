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
import type { BranchEvalReportLike } from "../../datasets/branch-eval.js"
import { buildRankingDatasetFromBranchEvalReport } from "../../datasets/branch-eval.js"
import { readJsonFile, writeJsonFile } from "../../io/index.js"

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", default: "" },
      output: { type: "string", default: "./output/gi-ml/branch-eval-dataset.json" },
      "dataset-id": { type: "string", default: "" },
      "include-ties": { type: "boolean", default: false },
    },
    strict: false,
  })

  const inputPath = values.input as string
  if (!inputPath) {
    throw new Error("input is required")
  }

  const report = await readJsonFile<BranchEvalReportLike>(resolve(inputPath))
  const dataset = buildRankingDatasetFromBranchEvalReport(report, {
    datasetId: (values["dataset-id"] as string) || undefined,
    includeTiePreferences: Boolean(values["include-ties"]),
  })

  const outputPath = await writeJsonFile(values.output as string, dataset)
  console.log(`Branch-eval ranking dataset written: ${outputPath}`)
  console.log(`query_groups=${dataset.query_groups.length}`)
}

main().catch((error) => {
  console.error("run-export-branch-eval-dataset fatal error:", error)
  process.exit(1)
})
