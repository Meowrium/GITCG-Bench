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
import {
  buildLibraryQueryFromCanonicalFingerprint,
  buildLibraryQueryFromWindow,
  selectCombatWindowLibrary,
} from "../library-selector.js"
import { TreeLake } from "../tree-lake.js"

async function main() {
  const { values } = parseArgs({
    options: {
      library: { type: "string", default: "./output/combat-windows/library.json" },
      windows: { type: "string", default: "" },
      "window-id": { type: "string", default: "" },
      "tree-lake": { type: "string", default: "" },
      "tree-id": { type: "string", default: "" },
      "query-mode": { type: "string", default: "window" },
      "matchup-id": { type: "string", default: "" },
      "deck-fingerprint-self": { type: "string", default: "" },
      "deck-fingerprint-opp": { type: "string", default: "" },
      "self-active-definition-id": { type: "string", default: "" },
      "opp-active-definition-id": { type: "string", default: "" },
      "expected-action-count": { type: "string", default: "" },
      limit: { type: "string", default: "5" },
      "min-score": { type: "string", default: "0.45" },
      output: { type: "string", default: "" },
    },
    strict: false,
  })

  const library = await readJsonFile<CombatWindowLibrary>(resolve(values.library as string))
  const queryMode = values["query-mode"] as string
  const queryOptions = {
    matchupId: emptyToNull(values["matchup-id"] as string),
    deckFingerprintSelf: emptyToNull(values["deck-fingerprint-self"] as string),
    deckFingerprintOpp: emptyToNull(values["deck-fingerprint-opp"] as string),
    selfActiveCharacterDefinitionId: parseNumber(values["self-active-definition-id"] as string),
    oppActiveCharacterDefinitionId: parseNumber(values["opp-active-definition-id"] as string),
    expectedActionCount: parseNumber(values["expected-action-count"] as string),
  }

  let querySource = ""
  let query

  if ((values["tree-lake"] as string) && (values["tree-id"] as string)) {
    const lake = new TreeLake(resolve(values["tree-lake"] as string))
    try {
      const tree = lake.getTree(values["tree-id"] as string)
      if (!tree) {
        throw new Error(`Tree not found: ${values["tree-id"] as string}`)
      }
      if (queryMode === "canonical") {
        if (!tree.canonical_fingerprint) {
          throw new Error(`Tree has no canonical_fingerprint: ${tree.tree_id}`)
        }
        query = buildLibraryQueryFromCanonicalFingerprint(tree.canonical_fingerprint)
        querySource = `tree:${tree.tree_id}:canonical`
      } else {
        query = buildLibraryQueryFromWindow(tree.source_window, queryOptions)
        querySource = `tree:${tree.tree_id}:window`
      }
    } finally {
      lake.close()
    }
  } else if ((values.windows as string) && (values["window-id"] as string)) {
    const extraction = await readJsonFile<CombatWindowExtractionResult>(
      resolve(values.windows as string),
    )
    const window = extraction.windows.find(
      (candidate) => candidate.window_id === (values["window-id"] as string),
    )
    if (!window) {
      throw new Error(`Window not found: ${values["window-id"] as string}`)
    }
    query = buildLibraryQueryFromWindow(window, queryOptions)
    querySource = `window:${window.window_id}`
  } else {
    throw new Error(
      "Provide either --windows + --window-id or --tree-lake + --tree-id",
    )
  }

  const selection = selectCombatWindowLibrary(library, query, {
    limit: Number(values.limit),
    minScore: Number(values["min-score"]),
  })
  const payload = {
    query_source: querySource,
    selection,
  }

  const output = values.output as string
  if (output) {
    const outputPath = resolve(output)
    await writeJsonFile(outputPath, payload)
    console.log(`Combat window query results written to ${outputPath}`)
    return
  }

  console.log(JSON.stringify(payload, null, 2))
}

function emptyToNull(value: string): string | null {
  return value.trim().length > 0 ? value : null
}

function parseNumber(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

main().catch((error) => {
  console.error("run-query-library fatal error:", error)
  process.exit(1)
})
