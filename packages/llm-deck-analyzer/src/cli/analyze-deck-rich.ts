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

/**
 * Rich deck analysis CLI - outputs structured pure-data deck context
 * for the battle LLM to reason from scratch.
 *
 * Output: { deckCode, deckName, deckContext, baseline? }
 *   - deckContext: characters / cards / entities / generatedHandCards / summary
 *   - baseline: heuristic DeckAnalysis (ONLY when LLM_DECK_ANALYZER_HEURISTICS=1)
 *
 * Heuristic layers (triggerChains, comboClock, skillEfficiency, resourceCycles,
 * zonePressure, etc.) are disabled by default. Set LLM_DECK_ANALYZER_HEURISTICS=1
 * to enable them and include the baseline in output.
 */

import { AssetsManager, DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import { createDeckContext } from "../deck-context"

const deckCode = process.env.DECK_CODE
const deckName = process.env.DECK_NAME || undefined
const version = process.env.DECK_VERSION || undefined
const heuristicsEnabled = process.env.LLM_DECK_ANALYZER_HEURISTICS === "1"

if (!deckCode) {
  console.error("DECK_CODE environment variable is required")
  process.exit(1)
}

const manager: AssetsManager = version ? new AssetsManager({ version }) : DEFAULT_ASSETS_MANAGER
const context = await createDeckContext(deckCode, manager)

const result: Record<string, unknown> = {
  deckCode,
  deckName: deckName || null,
  deckContext: {
    characters: context.characterFullInfo.map((ch) => ({
      name: ch.name,
      elements: ch.elements,
      weapon: ch.weapon,
      nations: ch.nations,
      hp: ch.hp,
      maxEnergy: ch.maxEnergy,
      skills: ch.skills.map((s) => ({
        name: s.name,
        type: s.type,
        description: s.description,
        playCost: s.playCost,
      })),
    })),
    cards: context.cards.map((c) => ({
      name: c.name,
      type: c.type,
      subtype: c.subtype,
      description: c.description,
      playingDescription: c.playingDescription || undefined,
      playCost: c.playCost,
      tags: c.meaningfulTags,
      relatedCharacterTag: c.relatedCharacterTag,
    })),
    cardCounts: context.summary.cardFrequencies
      .filter((f) => f.count > 1)
      .map((f) => ({ name: f.name, count: f.count })),
    entityDescriptions: Object.fromEntries(context.entityDescriptions),
    generatedHandCards: Object.fromEntries(context.generatedHandCardDescriptions),
    summary: {
      elementCounts: context.summary.elementCounts,
      nations: context.summary.nations,
      equipmentCount: context.summary.equipmentCount,
      eventCount: context.summary.eventCount,
      supportCount: context.summary.supportCount,
      talentCount: context.summary.talentCount,
      weaponCount: context.summary.weaponCount,
      artifactCount: context.summary.artifactCount,
      resonanceCount: context.summary.resonanceCount,
    },
  },
}

// Heuristic baseline - only computed when explicitly enabled
if (heuristicsEnabled) {
  const { DeckAnalyzer } = await import("../analyzer")
  const analyzer = new DeckAnalyzer(manager)
  result.baseline = await analyzer.analyzeDeck(deckCode, deckName)
}

console.log(JSON.stringify(result, null, 2))
