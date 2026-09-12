// Copyright (C) 2024-2025 Guyutongxue
//
// Temporal opportunity scoring — now backed by PortfolioSnapshot + TransitionEstimator.

import type { ObservationV1 } from "@gi-tcg/ml/contracts"
import type {
  PolicyCandidateAction,
  PolicyTurnDigest,
  RuntimeMacroPlan,
} from "./types.js"
import {
  buildPortfolioSnapshot,
  estimatePortfolioTransition,
  type PortfolioSnapshot,
} from "./portfolio-snapshot.js"

// ── Cache portfolio snapshot per decision point ──
let _cachedSnapshotDigest: PolicyTurnDigest | null = null
let _cachedSnapshot: PortfolioSnapshot | null = null

function getCachedSnapshot(
  observation: ObservationV1 | null | undefined,
  digest: PolicyTurnDigest,
): PortfolioSnapshot {
  if (_cachedSnapshotDigest === digest && _cachedSnapshot) {
    return _cachedSnapshot
  }
  _cachedSnapshotDigest = digest
  // IMPORTANT: do NOT inject the candidate being scored into digest
  _cachedSnapshot = buildPortfolioSnapshot(observation, digest.candidate_actions)
  return _cachedSnapshot
}

/** Reset cache (e.g. between decisions) */
export function resetPortfolioSnapshotCache(): void {
  _cachedSnapshotDigest = null
  _cachedSnapshot = null
}

export interface TemporalOpportunityEstimate {
  score: number
  reasons: string[]
}

/**
 * Score a candidate action's temporal opportunity value.
 *
 * Strategy:
 *   1. Build PortfolioSnapshot once per decision point (cached).
 *   2. For each candidate, estimate the transition delta.
 *   3. Merge with phase-fit heuristics for smooth transition.
 *
 * The snapshot handles:
 *   - Entity-variable classification (Liben collected count → progressing vs ready)
 *   - Synergy prerequisites (e.g. Chef Mao needs food)
 *   - Slot pressure (too many deferred supports on board)
 *   - Deferred option density
 *   - DeclareEnd risk (wasted cash, tempo risk)
 */
export function scoreTemporalOpportunity(
  digest: PolicyTurnDigest,
  candidate: PolicyCandidateAction,
  observation: ObservationV1 | null | undefined,
  macroPlan: RuntimeMacroPlan | null,
): TemporalOpportunityEstimate {
  const actionCase = String(candidate.action_case ?? "")
  const reasons: string[] = []

  // ── Build snapshot (cached, no candidate injection) ──
  const snapshot = getCachedSnapshot(observation, digest)

  // ── Estimate transition delta ──
  const delta = estimatePortfolioTransition(snapshot, candidate, observation, digest)
  let score = delta.deltaEV
  reasons.push(...delta.reasons)

  // ── Phase-fit heuristics ──
  if (actionCase === "playCard") {
    const defId = Number(candidate.card_definition_id ?? 0)
    const round = Number(digest.round ?? 0)

    // Liben bank specific: dice readiness
    if (defId === 322008) {
      const dice = observation?.self.dice.total_count ??
        Number((digest.resource_summary as Record<string, unknown>).dice_count ?? 0)
      const bankReadiness = Math.max(0, Math.min(1, Math.min(dice, 3) / 3))
      const phaseFit = round <= 1 ? 0.20 : round === 2 ? 0.10 : -0.12
      const libenScore = phaseFit + bankReadiness * 0.16
      score += libenScore
      reasons.push(`temporal_liben_bank=${formatSigned(libenScore)}`)
    }
  }

  return {
    score: Math.max(-1, Math.min(1, score)),
    reasons: [...delta.reasons, ...reasons.filter(r => !r.startsWith("portfolio_"))],
  }
}

function formatSigned(value: number): string {
  return value >= 0 ? `+${value.toFixed(2)}` : value.toFixed(2)
}
