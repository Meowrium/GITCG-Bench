// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * P0-3: Combo clock simulation.
 *
 * Estimates the earliest turn a deck can execute its key combo,
 * given realistic draw progress and card sequencing constraints.
 */

import type { DeckCardInfo, DeckCharacterFullInfo } from "../heuristics"
import type { DrawEstimate } from "./draw-expectation"

export interface ComboClockResult {
  /** Earliest turn the combo can fire (0 = starting, 1 = R1 end, etc.) */
  earliestTurn: number
  /** Required key cards for the combo */
  requiredCards: string[]
  /** Description of the combo sequence */
  description: string
  /** Confidence level: "high" | "medium" | "low" */
  confidence: "high" | "medium" | "low"
}

/** A combo pattern to detect */
interface ComboPattern {
  name: string
  /** Cards needed (by name pattern) */
  requiredCardPatterns: RegExp[]
  /** Optional cards that help */
  optionalCardPatterns: RegExp[]
  /** Minimum count of required cards that must be drawn */
  minRequiredInHand: number
  /** Turns after drawing cards before the combo can fire (deployment delay) */
  deploymentDelay: number
  /** Description of the combo */
  description: string
}

const COMBO_PATTERNS: ComboPattern[] = [
  {
    name: "Jiede OTK",
    requiredCardPatterns: [/婕德/, /净觉花/],
    optionalCardPatterns: [/迪娜泽黛/, /弥生七月/, /化种匣/],
    minRequiredInHand: 2,
    deploymentDelay: 1,
    description:
      "婕德阅历≥6→元素爆发触发沙与梦→下次技能-3骰终结",
  },
  {
    name: "Artifact recycle loop",
    requiredCardPatterns: [/琴音之诗/, /饰金之梦/],
    optionalCardPatterns: [/野猪公主/, /弥生七月/],
    minRequiredInHand: 2,
    deploymentDelay: 0,
    description:
      "琴音之诗回收圣遗物→野猪公主产骰→重打饰金之梦入场产骰→净骰+2-3",
  },
  {
    name: "Freeze control chain",
    requiredCardPatterns: [], // depends on characters
    optionalCardPatterns: [/换班时间/, /交给我吧/],
    minRequiredInHand: 0,
    deploymentDelay: 0,
    description:
      "水+冰角色交替挂元素→永冻控制",
  },
  {
    name: "Burst finish",
    requiredCardPatterns: [/赌徒/],
    optionalCardPatterns: [/本大爷还没有输！/, /运筹帷幄/],
    minRequiredInHand: 1,
    deploymentDelay: 1,
    description:
      "赌徒耳环击杀回骰→连动→继续击杀→雪球终结",
  },
]

/**
 * Simulate combo clock: given draw expectation and card list,
 * estimate earliest turn when key cards come together.
 */
export function estimateComboClock(
  cards: DeckCardInfo[],
  characters: DeckCharacterFullInfo[],
  drawEstimate: DrawEstimate,
): ComboClockResult[] {
  const cardNames = cards.map((c) => c.name)
  const results: ComboClockResult[] = []

  for (const pattern of COMBO_PATTERNS) {
    // Check if this pattern is possible with the deck
    const matchedCards: string[] = []
    const matchedOptional: string[] = []
    // Count copies, not just unique presence
    let totalCopies = 0

    for (const cardName of cardNames) {
      for (const regex of pattern.requiredCardPatterns) {
        if (regex.test(cardName)) {
          matchedCards.push(cardName)
          totalCopies++
        }
      }
      for (const regex of pattern.optionalCardPatterns) {
        if (regex.test(cardName) && !matchedOptional.includes(cardName)) {
          matchedOptional.push(cardName)
        }
      }
    }

    // Also check character-based combos
    if (pattern.name === "Freeze control chain") {
      const hydroCount = characters.filter((c) =>
        c.elements.some((e) => e === "水"),
      ).length
      const cryoCount = characters.filter((c) =>
        c.elements.some((e) => e === "冰"),
      ).length
      if (hydroCount > 0 && cryoCount > 0) {
        matchedCards.push("水角色", "冰角色")
      }
    }

    if (matchedCards.length < pattern.minRequiredInHand) continue

    // Estimate when the combo comes online
    // Cards start at R0 (5 cards in hand)
    const totalCards = cardNames.length
    // Use total copies for density, not unique card count
    const requiredCopies = totalCopies
    const comboDensity = requiredCopies / totalCards

    // Simple probability-based estimate:
    // Expected draws to find all combo pieces ≈ comboSize / density
    // Then add deployment delay
    const expectedCardsToFindAll =
      Math.ceil(requiredCopies / Math.max(comboDensity, 0.05))

    // Find which round we hit this cumulative draw
    let earliestRound = 0
    let cumulative = drawEstimate.totalDraws[0] ?? 5
    for (let round = 0; round < drawEstimate.totalDraws.length; round++) {
      if (cumulative >= expectedCardsToFindAll) {
        earliestRound = round + pattern.deploymentDelay
        break
      }
      cumulative =
        drawEstimate.totalDraws[Math.min(round + 1, drawEstimate.totalDraws.length - 1)]
    }

    // Confidence: high if we have optional cards and high density,
    // medium if just required, low if borderline
    let confidence: ComboClockResult["confidence"] = "medium"
    if (matchedOptional.length >= 2 && comboDensity >= 0.12) confidence = "high"
    if (comboDensity < 0.08) confidence = "low"

    results.push({
      earliestTurn: Math.min(earliestRound, 3),
      requiredCards: [...matchedCards, ...matchedOptional.slice(0, 2)],
      description: pattern.description,
      confidence,
    })
  }

  // Deduplicate by combo name
  const seen = new Set<string>()
  return results.filter((r) => {
    if (seen.has(r.description)) return false
    seen.add(r.description)
    return true
  })
}
