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

import { DeckAnalyzer, buildDeckAnalysisPrompt } from "../analyzer"
import { createDeckContext } from "../deck-context"
import { AssetsManager, DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"

const args = process.argv.slice(2)
const versionIndex = args.indexOf("--version")
const version = versionIndex >= 0 ? args[versionIndex + 1] : undefined
const positionalArgs = args.filter((_, i) => i !== versionIndex && i !== versionIndex + 1)

const deckCode = positionalArgs[0] || process.env.DECK_CODE
const deckName = positionalArgs[1] || process.env.DECK_NAME

if (!deckCode) {
  console.error("Usage: bun run analyze <deckCode> [deckName] [--version <version>]")
  console.error("Or set DECK_CODE environment variable")
  process.exit(1)
}

const manager: AssetsManager = version ? new AssetsManager({ version }) : DEFAULT_ASSETS_MANAGER
const analyzer = new DeckAnalyzer(manager)

console.log("Analyzing deck:", deckCode)
if (deckName) {
  console.log("Deck name:", deckName)
}

const result = await analyzer.analyzeDeck(deckCode, deckName)

console.log("\n=== Local Heuristic Analysis ===\n")
console.log(JSON.stringify(result, null, 2))

const context = await createDeckContext(deckCode, manager)
const prompt = buildDeckAnalysisPrompt(context)

console.log("\n=== LLM Analysis Prompt ===\n")
console.log(prompt)