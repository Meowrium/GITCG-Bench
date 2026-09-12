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

import { DeckAnalyzer } from "../analyzer"
import { AssetsManager, DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import { readFileSync, writeFileSync } from "node:fs"

const args = process.argv.slice(2)
const versionIndex = args.indexOf("--version")
const version = versionIndex >= 0 ? args[versionIndex + 1] : undefined
const positionalArgs = args.filter((_, i) => i !== versionIndex && i !== versionIndex + 1)

const inputFile = positionalArgs[0]
const outputFile = positionalArgs[1]

if (!inputFile) {
  console.error("Usage: bun run analyze:batch <input.json> [output.json] [--version <version>]")
  console.error("Input format: [{ code, name? }] or { decks: [...] }")
  process.exit(1)
}

const input = JSON.parse(readFileSync(inputFile, "utf-8")) as
  | Array<{ code: string; name?: string }>
  | { decks: Array<{ code: string; name?: string }> }
const decks = Array.isArray(input) ? input : input.decks

if (!Array.isArray(decks) || decks.some((deck) => typeof deck?.code !== "string")) {
  console.error("Invalid input format. Expected [{ code, name? }] or { decks: [...] }")
  process.exit(1)
}

const manager: AssetsManager = version ? new AssetsManager({ version }) : DEFAULT_ASSETS_MANAGER
const analyzer = new DeckAnalyzer(manager)

console.log(`Analyzing ${decks.length} decks (local heuristic mode)...`)

const results = []

for (let i = 0; i < decks.length; i++) {
  const deck = decks[i]
  console.log(`[${i + 1}/${decks.length}] Analyzing ${deck.name || deck.code}...`)

  try {
    const analysis = await analyzer.analyzeDeck(deck.code, deck.name)
    results.push(analysis)
  } catch (error) {
    console.error(`Failed to analyze ${deck.code}:`, error)
    results.push({ deckCode: deck.code, deckName: deck.name, error: String(error) })
  }
}

const outputPath = outputFile || inputFile.replace(".json", "-analysis.json")
writeFileSync(outputPath, JSON.stringify(results, null, 2))

console.log(`\nResults written to ${outputPath}`)