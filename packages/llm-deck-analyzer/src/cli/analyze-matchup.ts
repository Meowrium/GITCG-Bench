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

import { DeckAnalyzer, buildMatchupAnalysisPrompt } from "../analyzer"
import { createDeckContext } from "../deck-context"
import { AssetsManager, DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"

const args = process.argv.slice(2)
const versionIndex = args.indexOf("--version")
const version = versionIndex >= 0 ? args[versionIndex + 1] : undefined
const positionalArgs = args.filter((_, i) => i !== versionIndex && i !== versionIndex + 1)

const deckA = positionalArgs[0] || process.env.DECK_A_CODE
const deckB = positionalArgs[1] || process.env.DECK_B_CODE

if (!deckA || !deckB) {
  console.error("Usage: bun run analyze:matchup <deckACode> <deckBCode> [--version <version>]")
  console.error("Or set DECK_A_CODE / DECK_B_CODE environment variables")
  process.exit(1)
}

const manager: AssetsManager = version ? new AssetsManager({ version }) : DEFAULT_ASSETS_MANAGER
const analyzer = new DeckAnalyzer(manager)

console.log("Analyzing matchup:")
console.log("Deck A:", deckA)
console.log("Deck B:", deckB)

const result = await analyzer.analyzeMatchup(deckA, deckB)

console.log("\n=== Local Heuristic Matchup Analysis ===\n")
console.log(JSON.stringify(result, null, 2))

const deckAContext = await createDeckContext(deckA, manager)
const deckBContext = await createDeckContext(deckB, manager)
const prompt = buildMatchupAnalysisPrompt(deckAContext, deckBContext)

console.log("\n=== LLM Analysis Prompt ===\n")
console.log(prompt)