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
import { readJsonFile, writeJsonFile } from "../artifact-utils.js"
import type { CombatWindowLibrary } from "../export-library.js"
import {
  evaluateCombatWindowLibrary,
  type CombatWindowLibraryEvaluationQueryMode,
} from "../library-evaluator.js"
import { TreeLake } from "../tree-lake.js"

async function main() {
  const { values } = parseArgs({
    options: {
      library: { type: "string", default: "./output/combat-windows/library.json" },
      "tree-lake": { type: "string", default: "./output/combat-windows/tree-lake.sqlite" },
      "query-status": { type: "string", default: "validated" },
      "query-mode": { type: "string", default: "both" },
      "selection-limit": { type: "string", default: "5" },
      "min-score": { type: "string", default: "0.45" },
      "max-queries": { type: "string", default: "1000" },
      output: { type: "string", default: "" },
    },
    strict: false,
  })

  const library = await readJsonFile<CombatWindowLibrary>(resolve(values.library as string))
  const lake = new TreeLake(resolve(values["tree-lake"] as string))
  try {
    const trees = lake.listTrees({
      status: (values["query-status"] as string) as
        | "draft"
        | "validated"
        | "promoted"
        | "rejected",
      limit: Number(values["max-queries"]),
    })
    const report = evaluateCombatWindowLibrary(trees, library, {
      queryModes: parseQueryModes(values["query-mode"] as string),
      selectionLimit: Number(values["selection-limit"]),
      minScore: Number(values["min-score"]),
    })

    const output = values.output as string
    if (output) {
      const outputPath = resolve(output)
      await writeJsonFile(outputPath, report)
      console.log(`Combat window library evaluation written to ${outputPath}`)
    } else {
      console.log(JSON.stringify(report, null, 2))
    }

    for (const summary of report.summaries) {
      console.log(
        [
          `[${summary.query_mode}]`,
          `queries=${summary.query_count}`,
          `coverable=${summary.coverable_count}`,
          `hit@1(all)=${summary.hit_at_1_all.toFixed(3)}`,
          `hit@1(coverable)=${summary.hit_at_1_coverable.toFixed(3)}`,
          `avgTop1=${summary.avg_top1_final_score?.toFixed(3) ?? "n/a"}`,
        ].join(" "),
      )
    }
  } finally {
    lake.close()
  }
}

function parseQueryModes(value: string): CombatWindowLibraryEvaluationQueryMode[] {
  const normalized = value.trim().toLowerCase()
  if (!normalized || normalized === "all") {
    return ["runtime", "window", "canonical"]
  }
  if (normalized === "both") {
    return ["window", "canonical"]
  }
  if (
    normalized === "runtime" ||
    normalized === "window" ||
    normalized === "canonical"
  ) {
    return [normalized]
  }
  throw new Error(`Unsupported --query-mode: ${value}`)
}

main().catch((error) => {
  console.error("run-evaluate-library fatal error:", error)
  process.exit(1)
})
