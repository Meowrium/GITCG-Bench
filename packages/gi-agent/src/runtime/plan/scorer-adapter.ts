// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type { HeuristicProfile } from "../policy/baseline-policy.js"
import type { PolicyCandidateAction, PolicyDecisionContext } from "../policy/types.js"
import { checkDiceBudgetViolations } from "./dice-budget.js"
import { findMatchingPattern, matchAnyPattern } from "./pattern-matcher.js"
import type {
  DiceAllocation,
  DiceReservationBudget,
  PhaseWeightsOverride,
  SPLContext,
  ThreatBonusEntry,
} from "./types.js"

/**
 * Merge SPL phase weight overrides into the baseline heuristic profile.
 *
 * The SPL provides per-phase weight adjustments that overlay on top of
 * the profile selected by BaselinePolicy (adaptiveProfile or default).
 * SPL overrides take priority where specified.
 */
export function applyPhaseWeightOverrides(
  baseProfile: HeuristicProfile,
  overrides: PhaseWeightsOverride[],
): HeuristicProfile {
  let merged = { ...baseProfile }
  for (const override of overrides) {
    merged = { ...merged, ...override }
  }
  return merged
}

/**
 * Compute the threat bonus for a candidate action.
 *
 * Threat rules inject a large multiplier when a candidate matches
 * a priority action pattern. This ensures that defensive actions
 * (like food) can overpower greedy resource plays when a threat is active.
 */
export function computeThreatBonus(
  candidate: PolicyCandidateAction,
  threatBonusMap: Map<string, ThreatBonusEntry> | undefined,
): number {
  if (!threatBonusMap || threatBonusMap.size === 0) return 0

  let bonus = 0
  for (const [, entry] of threatBonusMap) {
    if (matchAnyPattern([entry.pattern], candidate)) {
      bonus += entry.multiplier
    }
  }
  return bonus
}

/**
 * Compute the primary pattern match bonus.
 *
 * When a candidate matches one of the primary action patterns for the
 * current phase, it receives a fixed additive bonus. This helps guide
 * the policy toward phase-appropriate actions.
 */
export function computePrimaryMatchBonus(
  candidate: PolicyCandidateAction,
  primaryPatterns: readonly ActionPattern[] | undefined,
  bonusAmount: number,
): number {
  if (!primaryPatterns || primaryPatterns.length === 0) return 0
  return matchAnyPattern(primaryPatterns, candidate) ? bonusAmount : 0
}

/**
 * Compute the dice budget penalty for a candidate action.
 *
 * Actions that would consume reserved dice receive a proportional
 * penalty. This is a soft constraint — we penalize rather than ban
 * to avoid deadlocks.
 */
export function computeDiceBudgetPenalty(
  candidate: PolicyCandidateAction,
  budget: readonly DiceReservationBudget[] | undefined,
  availableDice: Record<string, number>,
): number {
  if (!budget || budget.length === 0) return 0
  const result = checkDiceBudgetViolations(candidate, budget, availableDice)
  return result.penalty
}

/**
 * ── V2: Compute plan fitness penalty for a candidate.
 *
 * Low plan fitness (< 0.7) indicates poor dice-to-plan matching.
 * We apply a soft penalty to discourage actions that deviate from
 * the planned dice budget, scaled by how badly the fitness is hurt.
 */
export function computePlanFitnessPenalty(
  candidate: PolicyCandidateAction,
  diceAllocation: DiceAllocation | undefined,
): number {
  if (!diceAllocation) return 0

  // If the dice allocation isn't feasible, apply a moderate penalty
  if (!diceAllocation.feasible) {
    return 1.5
  }

  // Penalty scales with how many buckets fail to match
  const failedBuckets = diceAllocation.bucketAllocations.filter((b) => !b.matched).length
  return failedBuckets * 0.5
}

/**
 * Filter a candidate list to remove banned actions.
 *
 * Banned actions are removed entirely from the candidate pool before
 * scoring. This is a hard constraint — banned actions never execute.
 */
export function filterBannedActions(
  candidates: PolicyCandidateAction[],
  actionBanList: readonly ActionPattern[] | undefined,
): PolicyCandidateAction[] {
  if (!actionBanList || actionBanList.length === 0) return candidates
  return candidates.filter((c) => !matchAnyPattern(actionBanList, c))
}

// ---------------------------------------------------------------------------
// Context builder — assembles SPL fields into PolicyDecisionContext
// ---------------------------------------------------------------------------

export interface SPLPolicyContextFields {
  phaseWeightsOverride?: HeuristicProfile | null
  diceBudget?: readonly DiceReservationBudget[] | null
  threatBonusMap?: Map<string, ThreatBonusEntry> | null
  actionBanList?: readonly ActionPattern[] | null
  primaryPatterns?: readonly ActionPattern[] | null
  primaryMatchBonus?: number

  // ── V2 dice bucketing ──
  diceAllocation?: DiceAllocation | null
}

/**
 * Build SPL-related fields for PolicyDecisionContext from the SPLContext.
 *
 * @param splContext The output of StrategicPlanStateMachine.update()
 * @param baseProfile The heuristic profile selected by the policy
 * @returns Fields to merge into PolicyDecisionContext
 */
export function buildSPLContextFields(
  splContext: SPLContext,
  baseProfile: HeuristicProfile,
): SPLPolicyContextFields {
  const mergedProfile = applyPhaseWeightOverrides(
    baseProfile,
    splContext.phaseWeightsOverrides,
  )

  return {
    phaseWeightsOverride: mergedProfile,
    diceBudget: splContext.diceBudget,
    threatBonusMap: splContext.threatBonusMap,
    actionBanList: splContext.actionBanList,
    primaryPatterns: splContext.primaryPatterns,
    primaryMatchBonus: 2.0, // default, overridden per-phase
  }
}

// Re-export for convenience
import type { ActionPattern } from "./types.js"
