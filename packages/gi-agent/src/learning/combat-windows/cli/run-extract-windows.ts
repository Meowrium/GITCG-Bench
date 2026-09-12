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
import { writeJsonFile } from "../artifact-utils.js"
import { CombatWindowExtractor } from "../window-extractor.js"

async function main() {
  const { values } = parseArgs({
    options: {
      "runtime-plans-dir": { type: "string", default: "./runtime-plans" },
      output: { type: "string", default: "./output/combat-windows/windows.json" },
      "session-id": { type: "string", default: "" },
      "min-actions": { type: "string", default: "2" },
      "max-actions": { type: "string", default: "4" },
      "top-k-per-session": { type: "string", default: "24" },
    },
    strict: false,
  })

  const extractor = new CombatWindowExtractor()
  const result = await extractor.extract({
    runtime_plans_dir: resolve(values["runtime-plans-dir"] as string),
    session_id: (values["session-id"] as string) || undefined,
    min_actions: Number(values["min-actions"]),
    max_actions: Number(values["max-actions"]),
    top_k_per_session: Number(values["top-k-per-session"]),
  })
  const outputPath = resolve(values.output as string)
  await writeJsonFile(outputPath, result)

  console.log(`Combat windows extracted: ${result.windows.length}`)
  console.log(`Sessions scanned: ${result.sessions_scanned}`)
  console.log(`Output: ${outputPath}`)
}

main().catch((error) => {
  console.error("run-extract-windows fatal error:", error)
  process.exit(1)
})
