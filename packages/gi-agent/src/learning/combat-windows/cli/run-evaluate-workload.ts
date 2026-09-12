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
import type { CombatWindowExtractionResult } from "../types.js"
import type { CombatWindowLibrary } from "../export-library.js"
import { CombatWindowExtractor } from "../window-extractor.js"
import { evaluateCombatWindowLibraryWorkload } from "../library-workload-evaluator.js"

async function main() {
  const { values } = parseArgs({
    options: {
      library: { type: "string", default: "./output/combat-windows/library.json" },
      windows: { type: "string", default: "" },
      "runtime-plans-dir": { type: "string", default: "" },
      "min-actions": { type: "string", default: "2" },
      "max-actions": { type: "string", default: "4" },
      "top-k-per-session": { type: "string", default: "24" },
      "selection-limit": { type: "string", default: "5" },
      "min-score": { type: "string", default: "0.45" },
      "strong-match-threshold": { type: "string", default: "0.7" },
      output: { type: "string", default: "" },
    },
    strict: false,
  })

  const library = await readJsonFile<CombatWindowLibrary>(resolve(values.library as string))
  const extraction = await loadExtraction(values)
  const report = evaluateCombatWindowLibraryWorkload(extraction, library, {
    selectionLimit: Number(values["selection-limit"]),
    minScore: Number(values["min-score"]),
    strongMatchThreshold: Number(values["strong-match-threshold"]),
  })

  const output = values.output as string
  if (output) {
    const outputPath = resolve(output)
    await writeJsonFile(outputPath, report)
    console.log(`Combat window workload evaluation written to ${outputPath}`)
  } else {
    console.log(JSON.stringify(report, null, 2))
  }

  console.log(
    [
      `[runtime]`,
      `sessions=${report.sessions_scanned}`,
      `windows=${report.window_count}`,
      `matched=${report.matched_window_count}`,
      `strong=${report.strong_match_count}`,
      `avgTop1=${report.avg_top1_final_score?.toFixed(3) ?? "n/a"}`,
    ].join(" "),
  )
}

async function loadExtraction(
  values: Record<string, unknown>,
): Promise<CombatWindowExtractionResult> {
  const windowsPath = String(values.windows ?? "").trim()
  if (windowsPath) {
    return readJsonFile<CombatWindowExtractionResult>(resolve(windowsPath))
  }

  const runtimePlansDir = String(values["runtime-plans-dir"] ?? "").trim()
  if (!runtimePlansDir) {
    throw new Error("Provide either --windows or --runtime-plans-dir")
  }

  const extractor = new CombatWindowExtractor()
  return extractor.extract({
    runtime_plans_dir: resolve(runtimePlansDir),
    min_actions: Number(values["min-actions"]),
    max_actions: Number(values["max-actions"]),
    top_k_per_session: Number(values["top-k-per-session"]),
  })
}

main().catch((error) => {
  console.error("run-evaluate-workload fatal error:", error)
  process.exit(1)
})
