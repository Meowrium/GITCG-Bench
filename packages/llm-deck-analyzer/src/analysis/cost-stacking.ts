// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * P0-2: Cost stacking engine.
 *
 * Computes the effective (net) cost of playing a card by stacking
 * all applicable cost reductions from active effects.
 *
 * Currently, each discount (迪娜泽黛, 弥生七月, 化种匣, 琴音之诗,
 * 净觉花, etc.) is tracked independently. This module computes the
 * sum of all applicable discounts for a given card.
 */

import type { DeckCardInfo } from "../heuristics"

/** A single cost reduction source */
export interface CostDiscount {
  /** Card/entity providing the discount */
  source: string
  /** Amount of discount (in omni-dice equivalents) */
  amount: number
  /** Condition description */
  condition: string
  /** What card types this applies to */
  appliesTo: string[]
  /** Minimum raw dice cost of the target card (null = no requirement) */
  minRawCost?: number | null
  /** Per-turn limit (null = unlimited) */
  perTurnLimit: number | null
  /** Per-game limit (null = unlimited) */
  perGameLimit: number | null
}

/** Result of cost stacking computation */
export interface EffectiveCost {
  /** Raw cost (sum of all cost components) */
  rawCost: { type: string; count: number }[]
  /** Total raw cost in dice */
  rawDiceTotal: number
  /** Applicable discounts */
  appliedDiscounts: CostDiscount[]
  /** Total discount amount */
  totalDiscount: number
  /** Effective cost (capped at 0) */
  effectiveDiceCost: number
  /** Net resource change after play (including generate effects) */
  netDiceChange: number
}

/**
 * Known cost reduction patterns from card descriptions.
 *
 * Each entry maps a card name pattern to its discount rule.
 * The `appliesTo` array specifies which card types/subtypes get the discount.
 */
const COST_REDUCTION_CATALOG: Array<{
  namePattern: RegExp
  discount: Omit<CostDiscount, "source">
}> = [
  {
    namePattern: /迪娜泽黛/,
    discount: {
      amount: 1,
      condition: "打出伙伴支援牌时",
      appliesTo: ["伙伴"],
      perTurnLimit: 1,
      perGameLimit: null,
    },
  },
  {
    namePattern: /弥生七月/,
    discount: {
      amount: 1,
      condition: "打出圣遗物时（+场上已装备圣遗物角色数）",
      appliesTo: ["圣遗物"],
      perTurnLimit: 1,
      perGameLimit: null,
    },
  },
  {
    namePattern: /化种匣/,
    discount: {
      amount: 1,
      condition: "打出原费用至少为2的支援牌时",
      appliesTo: ["support"],
      minRawCost: 2,
      perTurnLimit: 1,
      perGameLimit: null,
    },
  },
  {
    namePattern: /净觉花/,
    discount: {
      amount: 1,
      condition: "本回合下次打出支援牌时",
      appliesTo: ["support"],
      perTurnLimit: 1,
      perGameLimit: null,
    },
  },
  {
    namePattern: /琴音之诗/,
    discount: {
      amount: 2,
      condition: "本回合下次打出圣遗物时",
      appliesTo: ["圣遗物"],
      perTurnLimit: 1,
      perGameLimit: null,
    },
  },
  // 注：白垩之术（@id 332009）是转移后台角色充能至出战角色，不减骰子费用，故不在减费目录中。
]

/**
 * Check if a card type/subtype matches a discount's applicability filter.
 */
function cardMatchesDiscount(
  card: DeckCardInfo,
  discount: { appliesTo: string[] },
): boolean {
  return discount.appliesTo.some((type) => {
    if (type === "圣遗物") return card.subtype === "圣遗物"
    if (type === "武器") return card.subtype === "武器"
    if (type === "天赋") return card.subtype === "天赋"
    if (type === "伙伴") return card.subtype === "伙伴"
    if (type === "equipment") return card.type === "equipment"
    if (type === "support") return card.type === "support"
    if (type === "event") return card.type === "event"
    return false
  })
}

/**
 * Compute the effective cost for playing a given card,
 * considering all cost reduction effects from other cards in the deck.
 */
export function computeEffectiveCost(
  card: DeckCardInfo,
  allCards: DeckCardInfo[],
): EffectiveCost {
  // Parse raw cost from playCost
  const rawCost = card.playCost || []
  const rawDiceTotal = rawCost.reduce(
    (sum, c) => sum + c.count,
    0,
  )

  // Find applicable discounts from other cards in the deck
  // (Cards that provide cost reduction but are NOT the card being played)
  const otherCards = allCards.filter((c) => c.id !== card.id)
  const appliedDiscounts: CostDiscount[] = []

  for (const { namePattern, discount } of COST_REDUCTION_CATALOG) {
    for (const source of otherCards) {
      if (namePattern.test(source.name)) {
        // Check if this discount applies to the target card
        const typeMatches = cardMatchesDiscount(card, discount)
        const costMatches =
          discount.minRawCost == null || rawDiceTotal >= discount.minRawCost
        if (typeMatches && costMatches) {
          appliedDiscounts.push({
            source: source.name,
            amount: discount.amount,
            condition: discount.condition,
            appliesTo: discount.appliesTo,
            minRawCost: discount.minRawCost,
            perTurnLimit: discount.perTurnLimit,
            perGameLimit: discount.perGameLimit,
          })
        }
      }
    }
  }

  const totalDiscount = appliedDiscounts.reduce(
    (sum, d) => sum + d.amount,
    0,
  )
  // Apply per-turn caps: each discount source can only apply once per turn
  // So the max discount is sum of unique sources, not sum of all copies
  const uniqueSources = new Set(appliedDiscounts.map(d => d.source))
  const cappedDiscount = [...uniqueSources].reduce((sum, source) => {
    const discount = appliedDiscounts.find(d => d.source === source)
    return sum + (discount?.amount ?? 0)
  }, 0)
  const effectiveDiceCost = Math.max(0, rawDiceTotal - cappedDiscount)

  // Estimate net dice change: cost paid minus dice generated on play
  // Default: no generation (most cards don't generate dice on play)
  let netDiceChange = -effectiveDiceCost

  // Common dice generation patterns from card descriptions
  const desc = card.description || ""
  const playingDesc = card.playingDescription || ""
  const fullText = `${desc} ${playingDesc}`

  if (/生成(\d+)个?万能元素/.test(fullText)) {
    const match = fullText.match(/生成(\d+)个?万能元素/)
    if (match) netDiceChange += parseInt(match[1], 10)
  }
  if (/生成(\d+)个?.*元素骰/.test(fullText)) {
    const match = fullText.match(/生成(\d+)个?.*元素骰/)
    if (match) netDiceChange += parseInt(match[1], 10)
  }
  // 饰金之梦 generates 1 matching + potentially 1 omni
  if (/饰金之梦/.test(card.name) && /3种不同元素/.test(fullText)) {
    netDiceChange += 2 // 1 matching + 1 omni
  }

  return {
    rawCost: rawCost.map((c) => ({ type: c.type, count: c.count })),
    rawDiceTotal,
    appliedDiscounts,
    totalDiscount,
    effectiveDiceCost,
    netDiceChange,
  }
}

/**
 * Compute effective costs for all cards in the deck.
 */
export function computeAllEffectiveCosts(
  cards: DeckCardInfo[],
): Map<string, EffectiveCost> {
  const result = new Map<string, EffectiveCost>()
  for (const card of cards) {
    result.set(card.name, computeEffectiveCost(card, cards))
  }
  return result
}

/**
 * Find cards that become FREE to play due to stacked discounts.
 */
export function findFreeCards(
  cards: DeckCardInfo[],
): Array<{ cardName: string; discounts: string[]; netDiceChange: number }> {
  const results: Array<{
    cardName: string
    discounts: string[]
    netDiceChange: number
  }> = []

  for (const card of cards) {
    const effective = computeEffectiveCost(card, cards)
    if (effective.effectiveDiceCost === 0 && effective.rawDiceTotal > 0) {
      results.push({
        cardName: card.name,
        discounts: effective.appliedDiscounts.map((d) => d.source),
        netDiceChange: effective.netDiceChange,
      })
    }
  }

  return results
}
