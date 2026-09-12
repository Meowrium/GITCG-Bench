// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type { ObservationV1 } from "@gi-tcg/ml/contracts"
import type {
  PolicyCandidateAction,
  PolicyTurnDigest,
  RuntimeMacroPlan,
} from "./types.js"

export interface StrategicValueEstimate {
  score: number
  reasons: string[]
}

export function estimateStrategicValueAdjustment(
  digest: PolicyTurnDigest,
  candidate: PolicyCandidateAction,
  observation: ObservationV1 | null | undefined,
  plan: RuntimeMacroPlan | null,
): StrategicValueEstimate {
  if (!observation) {
    return { score: 0, reasons: [] }
  }

  const reasons: string[] = []
  let score = 0
  const actionCase = String(candidate.action_case ?? "unknown")
  const selfSetupLead =
    observation.derived.self_setup_window_score - observation.derived.opp_setup_window_score
  const selfReserveLead =
    observation.derived.self_reserve_value_score - observation.derived.opp_reserve_value_score
  const activeHpRatio = currentSelfActiveHpRatio(digest)

  const setupValue =
    safeMetaSlot(candidate, "setup_dependency") * 0.6 +
    safeNumber(candidate.create_support_value) * 0.55 +
    safeNumber(candidate.create_summon_value) * 0.65
  if (setupValue > 0 && (selfSetupLead < 1 || plan?.kind === "board_setup")) {
    const bonus = setupValue * 0.35
    score += bonus
    reasons.push(`sv_setup=+${bonus.toFixed(2)}`)
  }

  const finisherValue =
    safeMetaSlot(candidate, "finisher_alignment") * 0.55 +
    safeMetaSlot(candidate, "burst_window_enable") * 0.7 +
    safeNumber(candidate.energy_gain_value) * 0.25
  if (finisherValue > 0 && plan?.kind === "burst_convert") {
    const bonus = finisherValue * 0.4
    score += bonus
    reasons.push(`sv_finisher=+${bonus.toFixed(2)}`)
  }

  const reactionValue =
    safeMetaSlot(candidate, "reaction_window_enable") * 0.65 +
    safeNumber(candidate.reaction_value) * 0.55 +
    safeNumber(candidate.damage_estimate) * 0.15
  if (reactionValue > 0 && plan?.kind === "reaction_convert") {
    const bonus = reactionValue * 0.35
    score += bonus
    reasons.push(`sv_reaction=+${bonus.toFixed(2)}`)
  }

  if (plan?.kind === "stabilize") {
    const stabilizeValue =
      safeNumber(candidate.healing_estimate) * 0.8 +
      safeNumber(candidate.self_heal_value) * 0.75 -
      safeNumber(candidate.survival_risk) * 0.3
    if (stabilizeValue !== 0) {
      score += stabilizeValue * 0.45
      reasons.push(`sv_stabilize=${(stabilizeValue * 0.45).toFixed(2)}`)
    }
    if (activeHpRatio <= 0.45 && actionCase === "declareEnd") {
      score -= 0.5
      reasons.push("sv_no_end=-0.50")
    }
  }

  if (actionCase === "elementalTuning") {
    const tunePenalty =
      safeMetaSlot(candidate, "retention_value_proxy") * 0.5 +
      safeMetaSlot(candidate, "setup_dependency_loss") * 0.45 +
      safeMetaSlot(candidate, "reaction_window_loss") * 0.35 +
      safeMetaSlot(candidate, "finisher_alignment_loss") * 0.35
    if (tunePenalty > 0 && (selfReserveLead <= 1.5 || plan?.resource_policy === "strict")) {
      score -= tunePenalty
      reasons.push(`sv_tune=-${tunePenalty.toFixed(2)}`)
    }
  } else if (selfReserveLead < 0.5 && plan?.resource_policy !== "aggressive") {
    score += 0.2
    reasons.push("sv_reserve=+0.20")
  }

  return { score, reasons }
}

function currentSelfActiveHpRatio(digest: PolicyTurnDigest): number {
  const summary = digest.self_summary as {
    active_character_id?: number
    characters?: Array<{ id?: number; hp?: number; max_hp?: number }>
  }
  const activeId = summary.active_character_id
  const characters = Array.isArray(summary.characters) ? summary.characters : []
  const active = characters.find((item) => item.id === activeId)
  if (!active) {
    return 1
  }
  return Number(active.hp ?? 0) / Math.max(1, Number(active.max_hp ?? 10))
}

function safeMetaSlot(candidate: PolicyCandidateAction, key: string): number {
  if (!candidate.meta_effect_slots || typeof candidate.meta_effect_slots !== "object") {
    return 0
  }
  const value = Number((candidate.meta_effect_slots as Record<string, unknown>)[key] ?? 0)
  return Number.isFinite(value) ? value : 0
}

function safeNumber(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}
