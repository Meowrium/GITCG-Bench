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
 * Rich matchup analysis CLI - outputs structured pure-data contexts for both sides
 * for the battle LLM to reason from scratch.
 *
 * Output: { deckA, deckB, deckAContext, deckBContext, baseline? }
 *   - deckAContext / deckBContext: pure-data structured contexts
 *   - baseline: heuristic MatchupAnalysis (ONLY when LLM_DECK_ANALYZER_HEURISTICS=1)
 *
 * Heuristic layers are disabled by default. Set LLM_DECK_ANALYZER_HEURISTICS=1
 * to enable them and include the baseline in output.
 */

import { AssetsManager, DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import { createDeckContext } from "../deck-context"

const deckA = process.env.DECK_A
const deckB = process.env.DECK_B
const version = process.env.DECK_VERSION || undefined
const heuristicsEnabled = process.env.LLM_DECK_ANALYZER_HEURISTICS === "1"

if (!deckA || !deckB) {
  console.error("DECK_A and DECK_B environment variables are required")
  process.exit(1)
}

const manager: AssetsManager = version ? new AssetsManager({ version }) : DEFAULT_ASSETS_MANAGER

// Pure-data contexts for both sides
const [ctxA, ctxB] = await Promise.all([
  createDeckContext(deckA, manager),
  createDeckContext(deckB, manager),
])

function buildContextData(ctx: typeof ctxA) {
  return {
    characters: ctx.characterFullInfo.map((ch) => ({
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
    cards: ctx.cards.map((c) => ({
      name: c.name,
      type: c.type,
      subtype: c.subtype,
      description: c.description,
      playingDescription: c.playingDescription || undefined,
      playCost: c.playCost,
      tags: c.meaningfulTags,
      relatedCharacterTag: c.relatedCharacterTag,
    })),
    cardCounts: ctx.summary.cardFrequencies
      .filter((f) => f.count > 1)
      .map((f) => ({ name: f.name, count: f.count })),
    entityDescriptions: Object.fromEntries(ctx.entityDescriptions),
    generatedHandCards: Object.fromEntries(ctx.generatedHandCardDescriptions),
    summary: {
      elementCounts: ctx.summary.elementCounts,
      nations: ctx.summary.nations,
      equipmentCount: ctx.summary.equipmentCount,
      eventCount: ctx.summary.eventCount,
      supportCount: ctx.summary.supportCount,
      talentCount: ctx.summary.talentCount,
      weaponCount: ctx.summary.weaponCount,
      artifactCount: ctx.summary.artifactCount,
      resonanceCount: ctx.summary.resonanceCount,
    },
  }
}

const result: Record<string, unknown> = {
  deckA: deckA,
  deckB: deckB,
  deckAContext: buildContextData(ctxA),
  deckBContext: buildContextData(ctxB),
}

// Heuristic matchup baseline - only computed when explicitly enabled
if (heuristicsEnabled) {
  const { createMatchupContext } = await import("../deck-context")
  const {
    createRichDeckContext,
    buildLocalDeckAnalysis,
    buildLocalMatchupAnalysis,
  } = await import("../heuristics")

  const [richA, richB] = await Promise.all([
    createRichDeckContext(deckA, manager),
    createRichDeckContext(deckB, manager),
  ])
  const matchupCtx = createMatchupContext(richA, richB)
  result.baseline = buildLocalMatchupAnalysis(
    matchupCtx,
    buildLocalDeckAnalysis(richA, "Deck A"),
    buildLocalDeckAnalysis(richB, "Deck B"),
  )
}

console.log(JSON.stringify(result, null, 2))
