// Copyright (C) 2024-2025 Guyutongxue
//
// Support zone pressure modeling.
// Estimates how fast a deck fills its support zone,
// and how many support discards (churn) to expect per game.

import type { DeckCardInfo } from "../heuristics"
import type { EffectiveCost } from "./cost-stacking"
import { computeEffectiveCost } from "./cost-stacking"

export interface ZonePressureReport {
  /** Total support cards in deck */
  totalSupports: number
  /** Support zone capacity */
  zoneCapacity: number
  /** Average support cost (raw dice) */
  avgSupportCost: number
  /** Average effective support cost (after discounts) */
  avgEffectiveCost: number
  /** Expected round to fill support zone */
  fillRound: number
  /** Expected excess supports beyond zone capacity per game */
  expectedExcess: number
  /** Expected support discards per game (from churn) */
  expectedDiscards: number
  /** Cards that benefit from support discards */
  discardBeneficiaries: string[]
}

export function analyzeZonePressure(
  cards: DeckCardInfo[],
): ZonePressureReport {
  const supports = cards.filter((c) => c.type === "support")
  const ZONE_CAPACITY = 4

  if (supports.length === 0) {
    return {
      totalSupports: 0,
      zoneCapacity: ZONE_CAPACITY,
      avgSupportCost: 0,
      avgEffectiveCost: 0,
      fillRound: 99,
      expectedExcess: 0,
      expectedDiscards: 0,
      discardBeneficiaries: [],
    }
  }

  // Compute average support cost
  const rawCosts = supports.map((s) => {
    const ec = computeEffectiveCost(s, cards)
    return { raw: ec.rawDiceTotal, effective: ec.effectiveDiceCost }
  })

  const avgRawCost =
    rawCosts.reduce((sum, c) => sum + c.raw, 0) / rawCosts.length
  const avgEffectiveCost =
    rawCosts.reduce((sum, c) => sum + c.effective, 0) / rawCosts.length

  // Estimate fill round: how many turns to fill 4 slots
  // R1: 8 dice → can play 8 / avgEffectiveCost supports
  // (minus 1-2 for essential character skills)
  const r1PlayableDice = 5 // conservative: ~5 dice for supports after skills
  const supportsPerRound = Math.max(1, Math.floor(r1PlayableDice / Math.max(avgEffectiveCost, 1)))

  // R1: supportsPerRound slots filled
  // Additional per round: ~3 free dice (after skills) → min(3/avgCost, 1) more
  const additionalPerRound = Math.max(1, Math.floor(3 / Math.max(avgEffectiveCost, 1)))
  let filled = 0
  let fillRound = 0
  for (let r = 0; r < 10 && filled < ZONE_CAPACITY; r++) {
    filled += r === 0 ? supportsPerRound : additionalPerRound
    fillRound = r
  }

  // Expected excess: total supports - zone capacity - natural expiration
  // Supports that expire naturally: 立本(2t), 常九爷(2-3t), 寻宝仙灵(2-3t)
  const naturalExpirations = supports.filter(
    (s) =>
      s.name.includes("立本") ||
      s.name.includes("常九爷") ||
      s.name.includes("寻宝仙灵") ||
      s.name.includes("婕德"),
  ).length
  const expectedExcess = Math.max(
    0,
    supports.length - ZONE_CAPACITY - naturalExpirations,
  )

  // Expected discards = total supports - those that stay until end
  const expectedDiscards = Math.max(0, supports.length - Math.min(ZONE_CAPACITY, 2))

  // Find cards that benefit from support discards
  const discardBeneficiaries = cards
    .filter((c) => {
      const desc = (c.description || "") + (c.playingDescription || "")
      return (
        /支援区弃置/.test(desc) ||
        /支援.*被弃置/.test(desc) ||
        /记录.*弃置/.test(desc) ||
        /弃置.*支援/.test(desc)
      )
    })
    .map((c) => c.name)

  return {
    totalSupports: supports.length,
    zoneCapacity: ZONE_CAPACITY,
    avgSupportCost: Math.round(avgRawCost * 10) / 10,
    avgEffectiveCost: Math.round(avgEffectiveCost * 10) / 10,
    fillRound: Math.max(0, fillRound),
    expectedExcess,
    expectedDiscards,
    discardBeneficiaries,
  }
}
