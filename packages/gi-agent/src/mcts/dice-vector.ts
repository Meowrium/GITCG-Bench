// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type { DiceType, ReadonlyDiceRequirement } from "@gi-tcg/typings"

/**
 * 8-dimensional dice vector, one slot per element.
 * Index [0..6] = Cryo..Dendro, [7] = Omni.
 *
 * This compact representation enables:
 *  - O(1) cost feasibility checks for MCTS action filtering
 *  - Efficient branch factor control (skip unaffordable actions)
 *  - Supporting newer cards that require non-character-element dice
 */
export type DiceVector = readonly [number, number, number, number, number, number, number, number]

const OMNI = 8
const ALIGNED = 8
const ENERGY = 9
const VOID = 0

/** Empty dice pool. */
export const DICE_ZERO: DiceVector = [0, 0, 0, 0, 0, 0, 0, 0]

/**
 * Build a DiceVector from the engine's dice array.
 * DiceType: Cryo=1, Hydro=2, Pyro=3, Electro=4, Anemo=5, Geo=6, Dendro=7, Omni=8
 */
export function diceVectorFromArray(dice: readonly DiceType[]): DiceVector {
  const v = [...DICE_ZERO] as number[]
  for (const d of dice) {
    if (d >= 1 && d <= 8) {
      v[d - 1]++
    }
  }
  return v as unknown as DiceVector
}

/**
 * Check if the current dice pool can afford a requirement.
 * Handles ALIGNED (matching element), VOID (any), ENERGY (ignored).
 * @param pool    current dice vector
 * @param cost    required cost (Map or readonly map)
 * @param alignedElement  the element that ALIGNED maps to (1-7), or null if unknown
 */
export function diceCanAfford(
  pool: DiceVector,
  cost: ReadonlyDiceRequirement,
  alignedElement: number | null = null,
): boolean {
  const remaining = [...pool] as number[]
  const alignedCount = cost.get(ALIGNED) ?? 0
  const omniCount = remaining[OMNI - 1]

  if (alignedCount > 0) {
    // Try matching element first
    if (alignedElement != null) {
      const matchCount = remaining[alignedElement - 1] + omniCount
      if (matchCount < alignedCount) return false
      // Pay with matching element + omni (just checking feasibility, don't mutate)
    } else {
      // Unknown aligned element — check if any element + omni can cover
      let found = false
      for (let i = 0; i < 7; i++) {
        if (remaining[i] + omniCount >= alignedCount) {
          found = true
          break
        }
      }
      if (!found && omniCount < alignedCount) return false
    }
  }

  // Check each specific requirement
  for (const [diceType, count] of cost) {
    if (diceType === VOID) continue
    if (diceType === ENERGY) continue
    if (diceType === ALIGNED) continue
    if (diceType >= 1 && diceType <= 7) {
      remaining[diceType - 1] -= count
      if (remaining[diceType - 1] < 0) {
        // Try to cover deficit with omni
        remaining[OMNI - 1] += remaining[diceType - 1]
        remaining[diceType - 1] = 0
        if (remaining[OMNI - 1] < 0) return false
      }
    }
  }

  return true
}

/**
 * Subtract a dice cost from the pool, returning a new vector.
 * Assumes `canAfford` was already checked.
 */
export function diceAfterPaying(
  pool: DiceVector,
  cost: ReadonlyDiceRequirement,
  alignedElement: number | null = null,
): DiceVector {
  const remaining = [...pool] as number[]
  const omniIdx = OMNI - 1

  // Pay ALIGNED
  const alignedCount = cost.get(ALIGNED) ?? 0
  if (alignedCount > 0) {
    if (alignedElement != null) {
      let toPay = alignedCount
      // Pay matching first
      const matchIdx = alignedElement - 1
      const matchPay = Math.min(toPay, remaining[matchIdx])
      remaining[matchIdx] -= matchPay
      toPay -= matchPay
      // Then omni
      remaining[omniIdx] -= toPay
    } else {
      // Try largest matching element pool
      let bestIdx = -1
      let bestCount = 0
      for (let i = 0; i < 7; i++) {
        if (remaining[i] > bestCount) {
          bestCount = remaining[i]
          bestIdx = i
        }
      }
      let toPay = alignedCount
      if (bestIdx >= 0) {
        const matchPay = Math.min(toPay, remaining[bestIdx])
        remaining[bestIdx] -= matchPay
        toPay -= matchPay
      }
      remaining[omniIdx] -= toPay
    }
  }

  // Pay specific elements
  for (const [diceType, count] of cost) {
    if (diceType === VOID || diceType === ENERGY || diceType === ALIGNED) continue
    if (diceType >= 1 && diceType <= 7) {
      let toPay = count as number
      const idx = diceType - 1
      const matchPay = Math.min(toPay, remaining[idx])
      remaining[idx] -= matchPay
      toPay -= matchPay
      // Cover deficit with omni
      remaining[omniIdx] -= toPay
    }
  }

  return remaining as unknown as DiceVector
}

/**
 * Total dice count in a vector.
 */
export function diceTotal(pool: DiceVector): number {
  return pool.reduce((s, c) => s + c, 0)
}

/**
 * Convert back to engine DiceType array (for debugging / display).
 */
export function diceVectorToArray(pool: DiceVector): DiceType[] {
  const result: DiceType[] = []
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < pool[i]; j++) {
      result.push((i + 1) as DiceType)
    }
  }
  return result
}
