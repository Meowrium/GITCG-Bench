// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type { PolicyCandidateAction } from "../policy/types.js"
import type { DiceAllocation, DiceBucket, DiceReservationBudget } from "./types.js"

/**
 * ── V2 Framework: Dice Bucketing Engine ──
 *
 * Implements "骰子分桶法" from §4.2 of the AI Decision Framework V2.
 *
 * Core principle: plan actions FIRST, then match dice to the plan.
 * Dice have no absolute value — their value is their marginal contribution
 * to the plan's Fitness(D, A) score.
 *
 * Usage:
 *   1. At turn start, list planned action sequence [A1, A2, ..., An]
 *   2. Create a DiceBucket for each action
 *   3. Call allocateDiceToBuckets(dicePool, buckets)
 *   4. If fitness < 0.7 → reroll/tune to fill gaps
 *   5. Execute actions in bucket order
 */

/**
 * Compute the Plan Fitness score — how well the current dice pool
 * matches the planned action sequence.
 *
 * Fitness(D, A) = min(1, available(D, type_i) / required(A, type_i))  ∀ type_i
 *
 * Result:
 *   1.0 → perfect match, can execute full plan
 *   0.7+ → acceptable, minor tuning needed
 *   0.5–0.7 → partial match, may need to reduce action count
 *   < 0.5 → plan not viable, must replan
 */
export function computePlanFitness(
  dicePool: Record<string, number>,
  buckets: DiceBucket[],
): number {
  if (buckets.length === 0) return 1.0

  // Aggregate required dice across all buckets
  const totalRequired: Record<string, number> = {}
  for (const bucket of buckets) {
    for (const [element, count] of Object.entries(bucket.requiredDice)) {
      totalRequired[element] = (totalRequired[element] ?? 0) + count
    }
  }

  if (Object.keys(totalRequired).length === 0) return 1.0

  // Compute per-element fitness, then overall min
  let minFitness = 1.0
  for (const [element, required] of Object.entries(totalRequired)) {
    const available = countMatchingDice(dicePool, element)
    const fitness = Math.min(1, available / required)
    minFitness = Math.min(minFitness, fitness)
  }

  return minFitness
}

/**
 * Allocate dice to buckets greedily by priority.
 *
 * Algorithm:
 *   For each bucket (sorted by priority ascending):
 *     - Try to fill the bucket with matching dice + omni
 *     - Remaining go to the next bucket
 *   Unused dice are left in the pool (can be banked or discarded)
 *
 * Returns an allocation result with per-bucket match status and
 * reroll suggestions for unfilled buckets.
 */
export function allocateDiceToBuckets(
  dicePool: Record<string, number>,
  buckets: DiceBucket[],
): DiceAllocation {
  if (buckets.length === 0) {
    return {
      feasible: true,
      fitness: 1.0,
      bucketAllocations: [],
      rerollSuggestions: [],
    }
  }

  // Sort buckets by priority (1 = highest)
  const sortedBuckets = [...buckets].sort((a, b) => a.priority - b.priority)

  // Work with a mutable copy of the dice pool
  const remaining = { ...dicePool }
  const bucketAllocations: DiceAllocation["bucketAllocations"] = []
  let anyFeasible = true

  for (const bucket of sortedBuckets) {
    // Check if the bucket can be filled from remaining dice
    const deficiency = computeBucketDeficiency(remaining, bucket.requiredDice)
    const matched = deficiency === 0

    if (!matched) {
      anyFeasible = false
    }

    // Consume the dice for this bucket (even if partially)
    for (const [element, count] of Object.entries(bucket.requiredDice)) {
      const consumed = Math.min(count, remaining[element] ?? 0)
      remaining[element] = Math.max(0, (remaining[element] ?? 0) - count)

      // If there's still a deficit, try omni
      const deficit = count - consumed
      if (deficit > 0 && remaining["omni"] != null) {
        const omniUsed = Math.min(deficit, remaining["omni"])
        remaining["omni"] = Math.max(0, remaining["omni"] - omniUsed)
      }
    }

    bucketAllocations.push({ bucket, matched, deficit: deficiency })
  }

  // Compute overall fitness
  const planFitness = computePlanFitness(dicePool, buckets)

  // Generate reroll suggestions for unfilled buckets
  const rerollSuggestions: Array<{ element: string; count: number; priority: number }> = []
  for (const ba of bucketAllocations) {
    if (!ba.matched) {
      for (const [element, count] of Object.entries(ba.bucket.requiredDice)) {
        const available = countMatchingDice(dicePool, element)
        const deficit = Math.max(0, count - available)
        if (deficit > 0) {
          rerollSuggestions.push({
            element,
            count: deficit,
            priority: ba.bucket.priority,
          })
        }
      }
    }
  }

  return {
    feasible: anyFeasible && buckets.length > 0,
    fitness: planFitness,
    bucketAllocations,
    rerollSuggestions,
  }
}

/**
 * Build DiceBuckets from a list of planned candidate actions.
 *
 * Converts candidate actions into the bucketing format required
 * by allocateDiceToBuckets. Each action with a defined dice cost
 * becomes a bucket.
 */
export function buildDiceBucketsFromActions(
  plannedActions: PolicyCandidateAction[],
): DiceBucket[] {
  return plannedActions
    .map((action, index) => {
      const cost = extractDiceCost(action)
      if (Object.keys(cost).length === 0) return null
      return {
        actionIndex: index,
        actionCase: action.action_case ?? `action_${index}`,
        requiredDice: cost,
        purpose: action.notes as string ?? action.action_case ?? `Step ${index + 1}`,
        priority: 2, // default medium priority
      }
    })
    .filter((b): b is DiceBucket => b !== null)
}

// ---------------------------------------------------------------------------
// Budget Reservation (existing, used by SPLContext)
// ---------------------------------------------------------------------------

export interface BudgetCheckResult {
  /** True if the candidate respects all must-keep (priority=1) budgets */
  compliant: boolean
  /** Number of budget violations */
  violations: number
  /** Severity of the worst violation (penalty multiplier) */
  penalty: number
  /** Per-budget detail for diagnostics */
  details: BudgetViolationDetail[]
}

export interface BudgetViolationDetail {
  budget: DiceReservationBudget
  deficit: number
  severity: "must_keep" | "suggested" | "breakable"
}

/**
 * Check a candidate action against the phase's dice budget.
 */
export function checkDiceBudgetViolations(
  candidate: PolicyCandidateAction,
  budgets: readonly DiceReservationBudget[],
  availableDice: Record<string, number>,
): BudgetCheckResult {
  if (budgets.length === 0) {
    return { compliant: true, violations: 0, penalty: 0, details: [] }
  }

  const details: BudgetViolationDetail[] = []
  let penalty = 0

  const cost = extractDiceCost(candidate)

  const remaining = { ...availableDice }
  for (const [element, count] of Object.entries(cost)) {
    remaining[element] = Math.max(0, (remaining[element] ?? 0) - count)
  }

  for (const budget of budgets) {
    const available = sumDiceForElement(remaining, budget.element)
    const deficit = Math.max(0, budget.count - available)

    if (deficit > 0) {
      const severity =
        budget.priority <= 1
          ? "must_keep"
          : budget.priority === 2
            ? "suggested"
            : "breakable"

      const severityMultiplier =
        severity === "must_keep" ? 3.0 : severity === "suggested" ? 1.5 : 0.5

      details.push({ budget, deficit, severity })
      penalty += severityMultiplier
    }
  }

  return {
    compliant: penalty === 0,
    violations: details.length,
    penalty,
    details,
  }
}

/**
 * Compute the recommended dice budget for a list of planned actions.
 */
export function computeDiceBudgetPlan(
  plannedActions: Array<{ element: string; count: number; priority: number }>,
  availableDice: number,
): DiceReservationBudget[] {
  const sorted = [...plannedActions].sort((a, b) => a.priority - b.priority)
  const budgets: DiceReservationBudget[] = []
  let remaining = availableDice

  for (const action of sorted) {
    if (remaining <= 0) break
    const reserve = Math.min(action.count, remaining)
    budgets.push({
      element: action.element,
      count: reserve,
      purpose: `reserved for action priority=${action.priority}`,
      priority: action.priority,
    })
    remaining -= reserve
  }

  return budgets
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractDiceCost(candidate: PolicyCandidateAction): Record<string, number> {
  const cost: Record<string, number> = {}
  const diceCostRaw = candidate.dice_cost

  if (Array.isArray(diceCostRaw)) {
    for (const entry of diceCostRaw) {
      if (entry && typeof entry === "object") {
        const el = String((entry as Record<string, unknown>).element ?? (entry as Record<string, unknown>).type ?? "omni")
        const cnt = Number((entry as Record<string, unknown>).count ?? 1)
        cost[el] = (cost[el] ?? 0) + cnt
      }
    }
    return cost
  }

  const totalCost = candidate.total_cost
  if (typeof totalCost === "number" && totalCost > 0) {
    cost["omni"] = totalCost
    return cost
  }

  const costValue = candidate.cost
  if (typeof costValue === "number" && costValue > 0) {
    cost["omni"] = costValue
  }

  return cost
}

function sumDiceForElement(
  dicePool: Record<string, number>,
  element: string,
): number {
  if (element === "any" || element === "omni") {
    return Object.values(dicePool).reduce((a, b) => a + b, 0)
  }
  const omniCount = dicePool["omni"] ?? 0
  const specificCount = dicePool[element] ?? 0
  return specificCount + omniCount
}

/**
 * Count how many dice in the pool match a given element (including omni).
 */
function countMatchingDice(
  dicePool: Record<string, number>,
  element: string,
): number {
  if (element === "omni") {
    return dicePool["omni"] ?? 0
  }
  const specific = dicePool[element] ?? 0
  const omni = dicePool["omni"] ?? 0
  return specific + omni
}

/**
 * Compute how many dice are deficient for a set of requirements.
 * Returns 0 if the requirements can be fully satisfied.
 */
function computeBucketDeficiency(
  pool: Record<string, number>,
  requirements: Record<string, number>,
): number {
  let totalDeficit = 0
  let remainingOmni = pool["omni"] ?? 0

  for (const [element, required] of Object.entries(requirements)) {
    if (element === "omni") {
      // Omni requirement can be satisfied by any die
      const totalAvailable = Object.values(pool).reduce((a, b) => a + b, 0)
      const deficit = Math.max(0, required - totalAvailable)
      totalDeficit += deficit
    } else {
      const specific = pool[element] ?? 0
      const fromSpecific = Math.min(required, specific)
      const remainder = required - fromSpecific
      const fromOmni = Math.min(remainder, remainingOmni)
      remainingOmni -= fromOmni
      const deficit = required - fromSpecific - fromOmni
      totalDeficit += deficit
    }
  }

  return totalDeficit
}
