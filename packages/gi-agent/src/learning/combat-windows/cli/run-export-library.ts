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
// License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { parseArgs } from "node:util"
import { resolve } from "node:path"
import { writeJsonFile } from "../artifact-utils.js"
import { exportCombatWindowLibrary } from "../export-library.js"
import { TreeLake } from "../tree-lake.js"

async function main() {
  const { values } = parseArgs({
    options: {
      "tree-lake": { type: "string", default: "./output/combat-windows/tree-lake.sqlite" },
      output: { type: "string", default: "./output/combat-windows/library.json" },
      status: { type: "string", default: "promoted" },
      limit: { type: "string", default: "1000" },
    },
    strict: false,
  })

  const lake = new TreeLake(resolve(values["tree-lake"] as string))
  try {
    const trees = lake.listTrees({
      status: values.status as "draft" | "validated" | "promoted" | "rejected",
      limit: Number(values.limit),
    })
    const library = exportCombatWindowLibrary(trees)
    const outputPath = resolve(values.output as string)
    await writeJsonFile(outputPath, library)
    console.log(`Combat window library exported: ${library.entry_count} entries`)
    console.log(`Grouped canonical keys: ${library.grouped_count}`)
    console.log(`Output: ${outputPath}`)
  } finally {
    lake.close()
  }
}

main().catch((error) => {
  console.error("run-export-library fatal error:", error)
  process.exit(1)
})
