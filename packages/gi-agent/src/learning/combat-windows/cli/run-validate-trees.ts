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
import { TreeLake } from "../tree-lake.js"
import { CombatWindowTreeValidator } from "../tree-validator.js"

async function main() {
  const { values } = parseArgs({
    options: {
      "tree-lake": { type: "string", default: "./output/combat-windows/tree-lake.sqlite" },
      status: { type: "string", default: "draft" },
      limit: { type: "string", default: "100" },
      "tree-id": { type: "string", default: "" },
    },
    strict: false,
  })

  const lake = new TreeLake(resolve(values["tree-lake"] as string))
  const validator = new CombatWindowTreeValidator()

  try {
    const treeId = (values["tree-id"] as string) || ""
    const candidates = treeId
      ? [lake.getTree(treeId)].filter((item): item is NonNullable<typeof item> => item != null)
      : lake.listTrees({
          status: values.status as "draft" | "validated" | "promoted" | "rejected",
          limit: Number(values.limit),
        })

    let validated = 0
    let rejected = 0
    for (const tree of candidates) {
      const result = validator.validateTree(tree)
      lake.insertValidationRun(result.run)
      lake.updateValidation({
        treeId: tree.tree_id,
        summary: result.summary,
      })
      if (result.summary.status === "validated") {
        validated += 1
      } else {
        rejected += 1
      }
      console.log(`${tree.tree_id}: ${result.summary.status} :: ${result.summary.reasons.join(" | ") || "ok"}`)
    }

    console.log(`Validation complete. validated=${validated} rejected=${rejected}`)
  } finally {
    lake.close()
  }
}

main().catch((error) => {
  console.error("run-validate-trees fatal error:", error)
  process.exit(1)
})
