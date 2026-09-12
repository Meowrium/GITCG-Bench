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

/**
 * Variant Generator - creates minimal-change deck variants for the benchmark.
 *
 * See docs/PRE_GAME_DECK_ANALYSIS_BENCHMARK.md §3 (Gold dataset).
 *
 * Variants are "minimum change" modifications of a base deck:
 *   - remove_payoff:   remove a unique payoff card, replace with a non-key filler
 *   - remove_enabler:  remove a key enabler, replace with a non-key filler
 *   - replace_draw:    swap a key card for a generic draw card (if available)
 *   - replace_defense: swap a key card for a defensive card (if available)
 *
 * Each variant records its lineage so the scorer can:
 *   1. Group variants with their parent (prevent train/test leakage)
 *   2. Check if the model still references the removed card (hallucination)
 */

import { AssetsManager, DEFAULT_ASSETS_MANAGER, staticEncode } from "@gi-tcg/assets-manager"
import { createDeckContext, type DeckContext } from "@gi-tcg/llm-deck-analyzer"
import type { Deck } from "@gi-tcg/typings"

// ─── Types ────────────────────────────────────────────────────────────────

export type VariantKind =
  | "remove_payoff"
  | "remove_enabler"
  | "replace_draw"
  | "replace_defense"

export interface DeckVariant {
  /** The variant deck code (base64) */
  deckCode: string
  /** The original deck code */
  parentDeckCode: string
  /** Lineage ID - shared between parent and all its variants */
  lineage: string
  /** Variant type */
  kind: VariantKind
  /** Card definition ID that was removed */
  removedCardId: number
  /** Card name that was removed */
  removedCardName: string
  /** Card definition ID that was added as replacement (0 = no replacement, deck size reduced) */
  addedCardId: number
  /** Card name that was added */
  addedCardName: string
  /** Human-readable description */
  description: string
}

export interface VariantResult {
  variants: DeckVariant[]
  /** Cards identified as "payoff" candidates */
  payoffCandidates: Array<{ id: number; name: string; reason: string }>
  /** Cards identified as "enabler" candidates */
  enablerCandidates: Array<{ id: number; name: string; reason: string }>
}

// ─── Key card identification ──────────────────────────────────────────────

/**
 * Identify "payoff" and "enabler" cards in a deck.
 *
 * Heuristics:
 * - Payoff: talent cards (GCG_TAG_TALENT) and legend cards (GCG_TAG_LEGEND)
 *   that are unique (count == 1) in the deck.
 * - Enabler: resonance cards and food cards that are unique.
 *
 * These are intentionally simple - the point is to create test variants,
 * not to perfectly classify every card.
 */
async function identifyKeyCards(
  deckCode: string,
  manager: AssetsManager,
): Promise<{
  context: DeckContext
  payoffCandidates: Array<{ id: number; name: string; reason: string }>
  enablerCandidates: Array<{ id: number; name: string; reason: string }>
  nonKeyCardIds: number[]
}> {
  const context = await createDeckContext(deckCode, manager)

  const payoffCandidates: Array<{ id: number; name: string; reason: string }> = []
  const enablerCandidates: Array<{ id: number; name: string; reason: string }> = []
  const nonKeyCardIds: number[] = []

  // Count card frequencies by definition ID
  const cardCounts = new Map<number, number>()
  for (const card of context.cards) {
    cardCounts.set(card.id, (cardCounts.get(card.id) ?? 0) + 1)
  }

  for (const card of context.cards) {
    // Skip duplicates (only consider unique cards as key piece candidates)
    if ((cardCounts.get(card.id) ?? 0) > 1) {
      nonKeyCardIds.push(card.id)
      continue
    }

    const tags = card.tags
    const meaningfulTags = card.meaningfulTags

    const isTalent = tags.includes("GCG_TAG_TALENT") || meaningfulTags.includes("天赋")
    const isLegend = tags.includes("GCG_TAG_LEGEND") || meaningfulTags.includes("秘传")
    const isResonance = tags.includes("GCG_TAG_RESONANCE") || meaningfulTags.includes("元素共鸣")
    const isFood = tags.includes("GCG_TAG_FOOD") || meaningfulTags.includes("料理")
    const isWeapon = tags.includes("GCG_TAG_WEAPON") || meaningfulTags.includes("武器")
    const isArtifact = tags.includes("GCG_TAG_ARTIFACT") || meaningfulTags.includes("圣遗物")

    if (isTalent || isLegend) {
      payoffCandidates.push({
        id: card.id,
        name: card.name,
        reason: isTalent ? "talent card (unique)" : "legend card (unique)",
      })
    } else if (isResonance || isFood) {
      enablerCandidates.push({
        id: card.id,
        name: card.name,
        reason: isResonance ? "resonance card (unique)" : "food card (unique)",
      })
    } else if (isWeapon || isArtifact) {
      // Equipment cards can be enablers too
      enablerCandidates.push({
        id: card.id,
        name: card.name,
        reason: isWeapon ? "weapon card (unique)" : "artifact card (unique)",
      })
    } else {
      nonKeyCardIds.push(card.id)
    }
  }

  return { context, payoffCandidates, enablerCandidates, nonKeyCardIds }
}

// ─── Variant generation ────────────────────────────────────────────────────

/**
 * Decode a deck code into character IDs and card IDs.
 */
function decodeDeckCode(deckCode: string, manager: AssetsManager): Deck {
  return manager.decode(deckCode) as Deck
}

/**
 * Create a variant by replacing one copy of `removeId` with `addId`.
 * Returns the new deck code, or null if the card to remove isn't in the deck.
 */
function createReplacementVariant(
  deckCode: string,
  removeId: number,
  addId: number,
  manager: AssetsManager,
): string | null {
  const deck = decodeDeckCode(deckCode, manager)
  const idx = deck.cards.indexOf(removeId)
  if (idx === -1) return null

  const newCards = [...deck.cards]
  newCards[idx] = addId
  const newDeck: Deck = { characters: deck.characters, cards: newCards }
  return staticEncode(newDeck)
}

/**
 * Pick a filler card from non-key cards in the deck.
 * Duplicates an existing non-key card to maintain deck legality.
 */
function pickFillerFromDeck(nonKeyCardIds: number[]): number | null {
  if (nonKeyCardIds.length === 0) return null
  // Pick the first non-key card (it will be duplicated)
  return nonKeyCardIds[0]!
}

/**
 * Generate all minimal-change variants for a deck.
 *
 * @param deckCode    Base deck code
 * @param lineage     Lineage ID (usually derived from deckCode hash or matchup id)
 * @param manager     AssetsManager (use version-specific for historical decks)
 * @returns           Variant result with all generated variants
 */
export async function generateVariants(
  deckCode: string,
  lineage: string,
  manager: AssetsManager = DEFAULT_ASSETS_MANAGER,
): Promise<VariantResult> {
  const { context, payoffCandidates, enablerCandidates, nonKeyCardIds } =
    await identifyKeyCards(deckCode, manager)

  const variants: DeckVariant[] = []
  const fillerId = pickFillerFromDeck(nonKeyCardIds)
  const fillerName = fillerId
    ? context.cards.find((c) => c.id === fillerId)?.name ?? `Card-${fillerId}`
    : "none"

  // Generate remove_payoff variants (up to 2)
  for (const payoff of payoffCandidates.slice(0, 2)) {
    if (fillerId !== null) {
      const newCode = createReplacementVariant(deckCode, payoff.id, fillerId, manager)
      if (newCode) {
        variants.push({
          deckCode: newCode,
          parentDeckCode: deckCode,
          lineage,
          kind: "remove_payoff" as VariantKind,
          removedCardId: payoff.id,
          removedCardName: payoff.name,
          addedCardId: fillerId,
          addedCardName: fillerName,
          description: `Removed payoff "${payoff.name}" (${payoff.reason}), replaced with "${fillerName}"`,
        })
      }
    }
  }

  // Generate remove_enabler variants (up to 2)
  for (const enabler of enablerCandidates.slice(0, 2)) {
    if (fillerId !== null) {
      const newCode = createReplacementVariant(deckCode, enabler.id, fillerId, manager)
      if (newCode) {
        variants.push({
          deckCode: newCode,
          parentDeckCode: deckCode,
          lineage,
          kind: "remove_enabler" as VariantKind,
          removedCardId: enabler.id,
          removedCardName: enabler.name,
          addedCardId: fillerId,
          addedCardName: fillerName,
          description: `Removed enabler "${enabler.name}" (${enabler.reason}), replaced with "${fillerName}"`,
        })
      }
    }
  }

  // Generate replace_draw variant: swap a payoff for a non-key card
  // (simulates replacing a key card with a generic draw/utility card)
  if (payoffCandidates.length > 0 && nonKeyCardIds.length >= 2) {
    const target = payoffCandidates[0]!
    const drawFiller = nonKeyCardIds[1]! // Use a different non-key card
    const drawFillerName = context.cards.find((c) => c.id === drawFiller)?.name ?? `Card-${drawFiller}`
    const newCode = createReplacementVariant(deckCode, target.id, drawFiller, manager)
    if (newCode) {
      variants.push({
        deckCode: newCode,
        parentDeckCode: deckCode,
        lineage,
        kind: "replace_draw" as VariantKind,
        removedCardId: target.id,
        removedCardName: target.name,
        addedCardId: drawFiller,
        addedCardName: drawFillerName,
        description: `Replaced payoff "${target.name}" with utility "${drawFillerName}"`,
      })
    }
  }

  // Generate replace_defense variant: swap an enabler for a non-key card
  if (enablerCandidates.length > 0 && nonKeyCardIds.length >= 3) {
    const target = enablerCandidates[0]!
    const defFiller = nonKeyCardIds[2]!
    const defFillerName = context.cards.find((c) => c.id === defFiller)?.name ?? `Card-${defFiller}`
    const newCode = createReplacementVariant(deckCode, target.id, defFiller, manager)
    if (newCode) {
      variants.push({
        deckCode: newCode,
        parentDeckCode: deckCode,
        lineage,
        kind: "replace_defense" as VariantKind,
        removedCardId: target.id,
        removedCardName: target.name,
        addedCardId: defFiller,
        addedCardName: defFillerName,
        description: `Replaced enabler "${target.name}" with defensive "${defFillerName}"`,
      })
    }
  }

  return {
    variants,
    payoffCandidates,
    enablerCandidates,
  }
}

/**
 * Generate a lineage ID from a deck code.
 * Uses a simple hash to group variants with their parent.
 */
export function makeLineageId(deckCode: string, label?: string): string {
  let hash = 0
  for (let i = 0; i < deckCode.length; i++) {
    const c = deckCode.charCodeAt(i)
    hash = ((hash << 5) - hash + c) | 0
  }
  const hashStr = Math.abs(hash).toString(36).padStart(6, "0")
  return label ? `${label}_${hashStr}` : `deck_${hashStr}`
}
