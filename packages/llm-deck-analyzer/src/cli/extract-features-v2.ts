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

import { extractDeckFeaturesV2, extractMatchupFeaturesV2 } from "../features"
import { AssetsManager, DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"

const args = process.argv.slice(2)
const versionIndex = args.indexOf("--version")
const version = versionIndex >= 0 ? args[versionIndex + 1] : undefined
const positionalArgs = args.filter((_, i) => i !== versionIndex && i !== versionIndex + 1)

const mode = positionalArgs[0]
const deckA = positionalArgs[1]
const deckB = positionalArgs[2]

if (!mode || !deckA) {
  console.error("Usage:")
  console.error("  bun run extract:features:v2 -- deck <deckCode> [--version <version>]")
  console.error("  bun run extract:features:v2 -- matchup <deckCodeA> <deckCodeB> [--version <version>]")
  process.exit(1)
}

const manager: AssetsManager = version ? new AssetsManager({ version }) : DEFAULT_ASSETS_MANAGER

if (mode === "deck") {
  const result = await extractDeckFeaturesV2(deckA, manager)
  console.log(JSON.stringify(result, null, 2))
} else if (mode === "matchup") {
  if (!deckB) {
    console.error("Missing deckCodeB for matchup mode")
    process.exit(1)
  }
  const result = await extractMatchupFeaturesV2(deckA, deckB, manager)
  console.log(JSON.stringify(result, null, 2))
} else {
  console.error(`Unknown mode: ${mode}`)
  process.exit(1)
}
