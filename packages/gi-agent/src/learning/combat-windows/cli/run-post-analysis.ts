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
import { CombatWindowPostAnalyzer } from "../post-analysis.js"
import { TreeLake } from "../tree-lake.js"
import type { CandidateCombatWindow, CombatWindowExtractionResult } from "../types.js"

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", default: "./output/combat-windows/windows.json" },
      "tree-lake": { type: "string", default: "./output/combat-windows/tree-lake.sqlite" },
      model: { type: "string", default: process.env.OPENAI_MODEL ?? "gpt-4o-mini" },
      temperature: { type: "string", default: "0" },
      limit: { type: "string", default: "0" },
      "window-id": { type: "string", default: "" },
      "skip-existing": { type: "boolean", default: true },
    },
    strict: false,
  })

  const payload = await readJsonFile<CombatWindowExtractionResult>(resolve(values.input as string))
  let windows = payload.windows
  const selectedWindowId = (values["window-id"] as string) || ""
  if (selectedWindowId) {
    windows = windows.filter((window) => window.window_id === selectedWindowId)
  }
  const limit = Number(values.limit)
  if (limit > 0) {
    windows = windows.slice(0, limit)
  }

  const lake = new TreeLake(resolve(values["tree-lake"] as string))
  const analyzer = new CombatWindowPostAnalyzer({
    model: values.model as string,
    temperature: Number(values.temperature),
  })

  try {
    let processed = 0
    for (const window of windows) {
      if (values["skip-existing"] && lake.findBySourceWindowId(window.window_id)) {
        console.log(`skip existing window ${window.window_id}`)
        continue
      }
      const analysis = await analyzer.analyzeWindow(window as CandidateCombatWindow)
      const record = lake.saveDraft({
        sourceWindow: window,
        analysis,
      })
      processed += 1
      console.log(`draft tree saved: ${record.tree_id} from ${window.window_id}`)
    }
    console.log(`Post-analysis complete. Draft trees processed: ${processed}`)
  } finally {
    lake.close()
  }
}

main().catch((error) => {
  console.error("run-post-analysis fatal error:", error)
  process.exit(1)
})
