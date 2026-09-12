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
import {
  extractConceptHypothesesFromCombatWindows,
  type CombatWindowConceptSourceLike,
  writeJsonFile,
} from "@gi-tcg/ml"
import { TreeLake } from "../tree-lake.js"
import type { TreeRecord, TreeStatus } from "../types.js"

interface CombatWindowConceptExport {
  generated_at: string
  source: "tree_lake"
  tree_lake_path: string
  status: string
  tree_count: number
  concept_count: number
  concepts: ReturnType<typeof extractConceptHypothesesFromCombatWindows>
}

async function main() {
  const { values } = parseArgs({
    options: {
      "tree-lake": { type: "string", default: "./output/combat-windows/tree-lake.sqlite" },
      output: { type: "string", default: "./output/gi-ml/combat-window-concepts.json" },
      status: { type: "string", default: "all" },
      limit: { type: "string", default: "0" },
      "tree-id": { type: "string", default: "" },
    },
    strict: false,
  })

  const treeLakePath = resolve(values["tree-lake"] as string)
  const lake = new TreeLake(treeLakePath)

  try {
    const trees = loadTrees(lake, {
      status: values.status as string,
      limit: Number(values.limit),
      treeId: values["tree-id"] as string,
    })

    const concepts = extractConceptHypothesesFromCombatWindows(
      trees.map(mapTreeRecordToConceptSource),
    )

    const payload: CombatWindowConceptExport = {
      generated_at: new Date().toISOString(),
      source: "tree_lake",
      tree_lake_path: treeLakePath,
      status: values.status as string,
      tree_count: trees.length,
      concept_count: concepts.length,
      concepts,
    }

    const outputPath = await writeJsonFile(values.output as string, payload)
    console.log(`Combat-window concepts written: ${outputPath}`)
    console.log(`trees=${trees.length} concepts=${concepts.length}`)
  } finally {
    lake.close()
  }
}

function loadTrees(
  lake: TreeLake,
  args: {
    status: string
    limit: number
    treeId: string
  },
): TreeRecord[] {
  if (args.treeId) {
    const tree = lake.getTree(args.treeId)
    return tree ? [tree] : []
  }

  const limit = args.limit > 0 ? args.limit : 1000
  if (args.status === "all") {
    return lake.listTrees({ limit })
  }

  return lake.listTrees({
    status: args.status as TreeStatus,
    limit,
  })
}

function mapTreeRecordToConceptSource(tree: TreeRecord): CombatWindowConceptSourceLike {
  return {
    tree_id: tree.tree_id,
    source_window: {
      window_id: tree.source_window.window_id,
      global_goal: tree.source_window.global_goal,
      tags: tree.source_window.tags,
    },
    analysis: tree.analysis,
  }
}

main().catch((error) => {
  console.error("run-export-combat-window-concepts fatal error:", error)
  process.exit(1)
})
