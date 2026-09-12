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
import { readJsonFile } from "../artifact-utils.js"
import { BranchEvalImporter, type BranchEvalReport } from "../branch-eval-import.js"
import { TreeLake } from "../tree-lake.js"

async function main() {
  const { values } = parseArgs({
    options: {
      "tree-lake": { type: "string", default: "./output/combat-windows/tree-lake.sqlite" },
      report: { type: "string", default: "" },
      status: { type: "string", default: "validated" },
      limit: { type: "string", default: "100" },
      "tree-id": { type: "string", default: "" },
    },
    strict: false,
  })

  const reportPath = values.report as string
  if (!reportPath) {
    throw new Error("report is required")
  }

  const report = await readJsonFile<BranchEvalReport>(resolve(reportPath))
  const lake = new TreeLake(resolve(values["tree-lake"] as string))
  const importer = new BranchEvalImporter()

  try {
    const treeId = (values["tree-id"] as string) || ""
    const trees = treeId
      ? [lake.getTree(treeId)].filter((item): item is NonNullable<typeof item> => item != null)
      : lake.listTrees({
          status: values.status as "draft" | "validated" | "promoted" | "rejected",
          limit: Number(values.limit),
        })

    let updated = 0
    let missed = 0
    for (const tree of trees) {
      const point = importer.findMatchingPoint(tree, report)
      if (!point) {
        missed += 1
        continue
      }
      const summary = importer.buildSummary(tree, report, point)
      lake.updateBranchEvalSummary({
        treeId: tree.tree_id,
        branchEvalSummary: summary,
      })
      updated += 1
      console.log(`${tree.tree_id}: branch-eval imported signal=${summary.promote_signal}`)
    }

    console.log(`Branch-eval import complete. updated=${updated} missed=${missed}`)
  } finally {
    lake.close()
  }
}

main().catch((error) => {
  console.error("run-import-branch-eval fatal error:", error)
  process.exit(1)
})
