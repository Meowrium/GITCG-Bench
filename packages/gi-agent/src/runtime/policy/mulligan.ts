// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * ── V2 Framework: Mulligan Evaluation Engine (§3.1) ──
 *
 * Core principle: "先确定开局策略，再按策略匹配手牌" — strategy first, cards second.
 *
 * The mulligan is not an isolated per-card value assessment. It is a
 * hierarchical decision:
 *   1. Determine opening strategy from deck composition
 *   2. Score each hand card against that strategy
 *   3. Keep/discard based on score ranking
 *
 * Card value patterns (§3.1 table):
 *   - 投资型 (Investment): High early, zero later → KEEP
 *   - 组合技型 (Combo): Value spikes at specific need → depends on strategy
 *   - 策略排斥型 (Strategy-conflicting): Current strategy doesn't need → DISCARD
 *   - 窗口衰减型 (Window-decaying): Value decreases over time → keep if space permits
 */

import type { HandObservationV1, CharacterObservationV1 } from "@gi-tcg/ml/contracts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CardValuePattern =
  | "investment"       // 投资型 — early value, zero later (Paimon, Vanarana)
  | "combo"            // 组合技型 — spikes at specific need (energy transfer)
  | "strategy_conflict" // 策略排斥型 — current strategy doesn't need (food when not tanking)
  | "window_decaying"  // 窗口衰减型 — value decreases over time (draw cards)
  | "core"             // 核心牌 — always keep (character-specific key cards)

export type MulliganKeepReason =
  | "investment_support"
  | "draw_card"
  | "core_combo_piece"
  | "early_setup"
  | "archetype_fit"
  | "default_keep"

export type MulliganDiscardReason =
  | "late_game_exclusive"
  | "survival_not_needed"
  | "strategy_mismatch"
  | "low_impact_early"

export interface MulliganCardScore {
  /** Card entity_id */
  cardId: number
  /** Card definition_id */
  definitionId: number | null
  /** Card tags */
  tags: string[]
  /** Score: higher = more valuable for this strategy */
  score: number
  /** Whether to keep this card */
  keep: boolean
  /** Value pattern classification */
  pattern: CardValuePattern
  /** Reason for keep/discard */
  reason: MulliganKeepReason | MulliganDiscardReason
}

export interface MulliganDecision {
  /** Cards to keep */
  keepCards: number[]
  /** Cards to discard (entity_ids) */
  discardCards: number[]
  /** The opening strategy chosen */
  openingStrategy: string
  /** Per-card scores */
  cardScores: MulliganCardScore[]
  /** Whether the deck's primary opening plan is viable */
  planViable: boolean
}

// ---------------------------------------------------------------------------
// Card tag patterns for strategy detection
// ---------------------------------------------------------------------------

const INVESTMENT_SUPPORT_KEYWORDS = [
  "paimon", "派蒙", "vanarana", "桓那兰那",
  "investment", "蓄爆", "ramp", "resource",
]

const DRAW_CARD_KEYWORDS = [
  "draw", "抽", "card_draw", "运筹帷幄", "strategic",
  "toss", "过牌",
]

const LATE_GAME_KEYWORDS = [
  "late", "后期", "burst", "爆发", "talent", "天赋",
  "arcane", "秘传", "legend", "flickering", "闪焰",
]

const SURVIVAL_KEYWORDS = [
  "food", "料理", "heal", "治疗", "shield", "护盾",
  "lotus", "莲花酥", "protect", "保护",
]

const COMBO_KEYWORDS = [
  "energy", "充能", "transfer", "传送", "转移",
  "白垩", "chalk",
]

// ---------------------------------------------------------------------------
// Deck composition analysis
// ---------------------------------------------------------------------------

export interface DeckOpeningProfile {
  /** The determined opening strategy */
  strategy: "setup_ramp" | "single_action" | "aggressive" | "control" | "flexible"
  /** Whether investment supports are core to this deck */
  usesInvestmentSupports: boolean
  /** Whether survival cards are relevant in opening */
  needsSurvivalOpening: boolean
  /** Character definition_ids that are damage dealers (not openers) */
  damageDealerIds: number[]
  /** Character definition_id that typically opens */
  openerId: number | null
}

// ---------------------------------------------------------------------------
// Main mulligan decision function
// ---------------------------------------------------------------------------

/**
 * Evaluate hand cards and produce a mulligan (switch hands) decision.
 *
 * @param handCards - Current hand observation
 * @param selfCharacters - Self character observations
 * @param deckProfile - Pre-computed deck opening profile
 * @returns MulliganDecision with keep/discard recommendations
 */
export function evaluateMulligan(
  handCards: HandObservationV1,
  selfCharacters: CharacterObservationV1[],
  deckProfile: DeckOpeningProfile,
): MulliganDecision {
  const cardScores: MulliganCardScore[] = []
  const visibleCards = handCards.visible_cards ?? []

  for (const card of visibleCards) {
    const score = scoreCardForMulligan(card, deckProfile)
    cardScores.push(score)
  }

  // Sort by score descending
  cardScores.sort((a, b) => b.score - a.score)

  // Determine how many cards to keep
  // In GI TCG, you can mulligan any number of cards (including 0)
  // The optimal number varies by hand quality
  const cardsToKeep = determineKeepCount(cardScores, deckProfile)

  const keepCards = cardScores
    .slice(0, cardsToKeep)
    .map((s) => s.cardId)
  const discardCards = cardScores
    .slice(cardsToKeep)
    .map((s) => s.cardId)

  // Determine opening strategy from deck profile if not already set
  const strategy = deckProfile.strategy

  // Check if plan is viable: at least some core cards are in keep set
  const coreCardsKept = cardScores
    .slice(0, cardsToKeep)
    .filter((s) => s.pattern === "investment" || s.pattern === "core")
  const planViable = coreCardsKept.length > 0 || deckProfile.strategy === "flexible"

  return {
    keepCards,
    discardCards,
    openingStrategy: strategy,
    cardScores,
    planViable,
  }
}

// ---------------------------------------------------------------------------
// Card scoring
// ---------------------------------------------------------------------------

function scoreCardForMulligan(
  card: HandObservationV1["visible_cards"][0],
  deckProfile: DeckOpeningProfile,
): MulliganCardScore {
  const tags = card.tags ?? []
  const allTags = tags.map((t) => t.toLowerCase())
  const allText = allTags.join(" ")

  // Check investment supports
  if (matchesKeyword(allText, INVESTMENT_SUPPORT_KEYWORDS)) {
    return {
      cardId: card.entity_id,
      definitionId: card.definition_id,
      tags,
      score: 100,
      keep: true,
      pattern: "investment",
      reason: "investment_support",
    }
  }

  // Check draw cards
  if (matchesKeyword(allText, DRAW_CARD_KEYWORDS)) {
    return {
      cardId: card.entity_id,
      definitionId: card.definition_id,
      tags,
      score: 80,
      keep: true,
      pattern: "window_decaying",
      reason: "draw_card",
    }
  }

  // Check late game exclusives
  if (matchesKeyword(allText, LATE_GAME_KEYWORDS)) {
    return {
      cardId: card.entity_id,
      definitionId: card.definition_id,
      tags,
      score: 30,
      keep: false,
      pattern: "strategy_conflict",
      reason: "late_game_exclusive",
    }
  }

  // Check survival cards
  if (matchesKeyword(allText, SURVIVAL_KEYWORDS)) {
    if (!deckProfile.needsSurvivalOpening) {
      return {
        cardId: card.entity_id,
        definitionId: card.definition_id,
        tags,
        score: 20,
        keep: false,
        pattern: "strategy_conflict",
        reason: "survival_not_needed",
      }
    }
    return {
      cardId: card.entity_id,
      definitionId: card.definition_id,
      tags,
      score: 50,
      keep: true,
      pattern: "window_decaying",
      reason: "default_keep",
    }
  }

  // Check combo cards
  if (matchesKeyword(allText, COMBO_KEYWORDS)) {
    if (deckProfile.strategy === "setup_ramp") {
      return {
        cardId: card.entity_id,
        definitionId: card.definition_id,
        tags,
        score: 60,
        keep: true,
        pattern: "combo",
        reason: "core_combo_piece",
      }
    }
    return {
      cardId: card.entity_id,
      definitionId: card.definition_id,
      tags,
      score: 40,
      keep: false,
      pattern: "combo",
      reason: "strategy_mismatch",
    }
  }

  // Default: medium score, keep
  return {
    cardId: card.entity_id,
    definitionId: card.definition_id,
    tags,
    score: 50,
    keep: true,
    pattern: "window_decaying",
    reason: "default_keep",
  }
}

// ---------------------------------------------------------------------------
// Keep count determination
// ---------------------------------------------------------------------------

function determineKeepCount(
  scored: MulliganCardScore[],
  _deckProfile: DeckOpeningProfile,
): number {
  // Keep all cards scored > 50, discard the rest
  // This is the threshold-based approach matching the document's logic:
  // Investment (100) and Draw (80) are always kept.
  // Survival (50) and default (50) are kept if space permits.
  // Late game (30) and strategy mismatch (20) are discarded.
  const kept = scored.filter((s) => s.score >= 50).length
  return Math.min(kept, scored.length)
}

// ---------------------------------------------------------------------------
// Deck profile builder
// ---------------------------------------------------------------------------

/**
 * Build a DeckOpeningProfile from character and card pool information.
 *
 * Analyzes the deck's characters and cards to determine:
 *   - Opening strategy archetype
 *   - Whether investment supports are used
 *   - Whether survival cards are needed in opening
 *   - Which character opens vs deals damage
 */
export function buildDeckOpeningProfile(
  characterDefinitions: Array<{ definition_id: number; tags: string[] }>,
  cardTags: string[],
): DeckOpeningProfile {
  const allCardText = cardTags.join(" ").toLowerCase()

  // Detect archetype
  const usesInvestment = INVESTMENT_SUPPORT_KEYWORDS.some((kw) => allCardText.includes(kw))

  // Determine if survival cards are needed in opening
  // Based on whether the opener tends to stay on field or switch off
  const hasEarlyPressure = /aggro|rush|快攻|抢血/.test(allCardText)
  const needsSurvival = hasEarlyPressure  // aggro decks need opener to survive

  // Determine opening character (the one with lowest cost-to-benefit ratio)
  const openerId = characterDefinitions.length > 0 ? characterDefinitions[0].definition_id : null

  // Non-opener characters are potential damage dealers
  const damageDealerIds = characterDefinitions
    .slice(1)
    .map((c) => c.definition_id)

  // Choose strategy
  let strategy: DeckOpeningProfile["strategy"] = "flexible"
  if (usesInvestment) {
    strategy = "setup_ramp"
  } else if (hasEarlyPressure) {
    strategy = "aggressive"
  } else if (characterDefinitions.length >= 3) {
    strategy = "control"
  } else {
    strategy = "flexible"
  }

  return {
    strategy,
    usesInvestmentSupports: usesInvestment,
    needsSurvivalOpening: needsSurvival,
    damageDealerIds,
    openerId,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchesKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((kw) => text.includes(kw.toLowerCase()))
}
