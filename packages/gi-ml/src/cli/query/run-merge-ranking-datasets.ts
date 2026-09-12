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
import { mergeRankingDatasets } from "../../datasets/merge.js"
import { readJsonFile, writeJsonFile } from "../../io/index.js"

async function main() {
  const { values } = parseArgs({
    options: {
      inputs: { type: "string", default: "" },
      output: { type: "string", default: "" },
      "dataset-id": { type: "string", default: "" },
    },
    strict: false,
  })

  const inputValue = values.inputs as string
  if (!inputValue) {
    throw new Error("inputs is required")
  }

  const inputPaths = inputValue
    .split(",")
    .map((item) => resolve(item.trim()))
    .filter((item) => item.length > 0)

  if (inputPaths.length === 0) {
    throw new Error("no valid inputs provided")
  }

  const datasets = await Promise.all(
    inputPaths.map((path) => readJsonFile<MlRankingDataset>(path)),
  )
  const merged = mergeRankingDatasets(datasets, {
    datasetId: (values["dataset-id"] as string) || undefined,
  })

  const outputPath = (values.output as string) || "./output/gi-ml/merged-ranking-dataset.json"
  const written = await writeJsonFile(outputPath, merged)
  console.log(`Merged ranking dataset written: ${written}`)
  console.log(`source_datasets=${inputPaths.length}`)
  console.log(`query_groups=${merged.query_groups.length}`)
}

main().catch((error) => {
  console.error("run-merge-ranking-datasets fatal error:", error)
  process.exit(1)
})
