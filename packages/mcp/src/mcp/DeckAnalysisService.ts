// Copyright (C) 2025 Guyutongxue
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

import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import { createDeckContext } from "@gi-tcg/llm-deck-analyzer"

/**
 * DeckAnalysisService - delegates to @gi-tcg/llm-deck-analyzer's createDeckContext
 * for rich pure-data deck context (characters, skills, cards, entities, etc).
 *
 * The old shallow tag-counting analysis has been removed; this service now
 * returns the same deep data structure that the opencode subagent uses.
 */
export class DeckAnalysisService {
  async analyzeDeck(args: Record<string, unknown>): Promise<{
    ok: boolean
    analysis?: unknown
    error?: string
  }> {
    const deckCode = typeof args.deck_code === "string" ? args.deck_code.trim() : ""
    const deckName = typeof args.deck_name === "string" ? args.deck_name : "Unknown"

    if (!deckCode) {
      return { ok: false, error: "Missing required parameter: deck_code" }
    }

    try {
      const context = await createDeckContext(deckCode, DEFAULT_ASSETS_MANAGER)

      const analysis = {
        deckCode,
        deckName,
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
      }

      return { ok: true, analysis }
    } catch (e: any) {
      return { ok: false, error: `Failed to analyze deck: ${e?.message ?? String(e)}` }
    }
  }

  async analyzeMatchup(args: Record<string, unknown>): Promise<{
    ok: boolean
    matchup?: unknown
    error?: string
  }> {
    const myCode = typeof args.my_deck_code === "string" ? args.my_deck_code : ""
    const myName = typeof args.my_deck_name === "string" ? args.my_deck_name : "My Deck"
    const oppCode = typeof args.opponent_deck_code === "string" ? args.opponent_deck_code : ""
    const oppName = typeof args.opponent_deck_name === "string" ? args.opponent_deck_name : "Opponent"

    if (!myCode || !oppCode) {
      return { ok: false, error: "Missing required parameters: my_deck_code and opponent_deck_code" }
    }

    try {
      const [myContext, oppContext] = await Promise.all([
        createDeckContext(myCode, DEFAULT_ASSETS_MANAGER),
        createDeckContext(oppCode, DEFAULT_ASSETS_MANAGER),
      ])

      const buildSide = (ctx: typeof myContext, name: string) => ({
        deckName: name,
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
      })

      const matchup = {
        myDeck: buildSide(myContext, myName),
        opponentDeck: buildSide(oppContext, oppName),
      }

      return { ok: true, matchup }
    } catch (e: any) {
      return { ok: false, error: `Failed to analyze matchup: ${e?.message ?? String(e)}` }
    }
  }
}
