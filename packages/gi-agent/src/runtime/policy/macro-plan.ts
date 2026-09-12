// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type { CombatWindowLibrarySelection } from "../../learning/combat-windows/library-selector.js"
import type { ObservationV1 } from "@gi-tcg/ml/contracts"
import type {
  PolicyCandidateAction,
  PolicyTurnDigest,
  RuntimeMacroPlan,
  RuntimeMacroPlanState,
} from "./types.js"

export interface MacroPlanCandidateScore {
  score: number
  reasons: string[]
}

export function resolveRuntimeMacroPlanState(
  digest: PolicyTurnDigest,
  observation: ObservationV1 | null | undefined,
  previous: RuntimeMacroPlanState | null | undefined,
  selection: CombatWindowLibrarySelection | null,
): RuntimeMacroPlanState {
  const libraryPlan = deriveCombatWindowMacroPlan(selection)
  const previousPlan = previous?.plan ?? null
  const activePlan =
    libraryPlan ??
    (shouldKeepPreviousPlan(previousPlan, digest, observation)
      ? previousPlan
      : buildHeuristicMacroPlan(digest, observation))
  return {
    plan: activePlan,
    trace: [
      ...(previous?.trace ?? []).slice(-2),
      activePlan ? `${activePlan.source}:${activePlan.kind}` : "none",
    ],
  }
}

export function advanceRuntimeMacroPlanState(
  state: RuntimeMacroPlanState | null | undefined,
  selectedCandidate: PolicyCandidateAction | null | undefined,
): RuntimeMacroPlanState | null {
  if (!state?.plan) {
    return state ?? null
  }
  const nextRemaining = Math.max(0, state.plan.remaining_actions - 1)
  const selectedActionCase = String(selectedCandidate?.action_case ?? "unknown")
  if (nextRemaining <= 0 || selectedActionCase === "declareEnd") {
    return {
      plan: null,
      trace: [...state.trace.slice(-2), `done:${selectedActionCase}`],
    }
  }
  return {
    plan: {
      ...state.plan,
      remaining_actions: nextRemaining,
    },
    trace: [...state.trace.slice(-2), `step:${selectedActionCase}`],
  }
}

export function scoreCandidateAgainstMacroPlan(
  digest: PolicyTurnDigest,
  candidate: PolicyCandidateAction,
  observation: ObservationV1 | null | undefined,
  plan: RuntimeMacroPlan | null,
): MacroPlanCandidateScore {
  if (!plan) {
    return { score: 0, reasons: [] }
  }

  const actionCase = String(candidate.action_case ?? "unknown")
  const tagSet = candidateTagSet(candidate)
  const reasons: string[] = []
  let score = 0

  if (plan.prefer_action_cases.includes(actionCase)) {
    score += 1.1
    reasons.push(`plan_case=${actionCase}`)
  }

  const tagMatches = plan.prefer_tags.filter((tag) => tagSet.has(tag)).length
  if (tagMatches > 0) {
    const bonus = Math.min(1.2, tagMatches * 0.35)
    score += bonus
    reasons.push(`plan_tags=+${bonus.toFixed(2)}`)
  }

  const avoidMatches = plan.avoid_tags.filter((tag) => tagSet.has(tag)).length
  if (avoidMatches > 0) {
    const penalty = Math.min(2.2, avoidMatches * 0.65)
    score -= penalty
    reasons.push(`plan_avoid=-${penalty.toFixed(2)}`)
  }

  switch (plan.kind) {
    case "board_setup": {
      const bonus =
        safeNumber(candidate.create_support_value) * 0.9 +
        safeNumber(candidate.create_summon_value) * 1.05 +
        safeMetaSlot(candidate, "setup_dependency") * 0.6 +
        safeMetaSlot(candidate, "tempo_gain_now") * 0.2
      if (bonus !== 0) {
        score += bonus
        reasons.push(`plan_board=+${bonus.toFixed(2)}`)
      }
      break
    }
    case "reaction_convert": {
      const bonus =
        safeNumber(candidate.reaction_value) * 0.95 +
        safeMetaSlot(candidate, "reaction_window_enable") * 0.55 +
        safeNumber(candidate.damage_estimate) * 0.3
      if (bonus !== 0) {
        score += bonus
        reasons.push(`plan_reaction=+${bonus.toFixed(2)}`)
      }
      break
    }
    case "burst_convert": {
      const bonus =
        safeMetaSlot(candidate, "burst_window_enable") * 0.9 +
        safeMetaSlot(candidate, "finisher_alignment") * 0.6 +
        safeNumber(candidate.energy_gain_value) * 0.35 +
        safeNumber(candidate.damage_estimate) * 0.2
      if (bonus !== 0) {
        score += bonus
        reasons.push(`plan_burst=+${bonus.toFixed(2)}`)
      }
      break
    }
    case "stabilize": {
      const bonus =
        safeNumber(candidate.healing_estimate) * 1.05 +
        safeNumber(candidate.self_heal_value) * 0.8 +
        safeNumber(candidate.team_heal_value) * 0.5 -
        safeNumber(candidate.survival_risk) * 0.25
      if (bonus !== 0) {
        score += bonus
        reasons.push(`plan_stabilize=${bonus >= 0 ? "+" : ""}${bonus.toFixed(2)}`)
      }
      if (actionCase === "switchActive") {
        score += 0.2
        reasons.push("plan_switch=+0.20")
      }
      break
    }
    case "tempo_pressure":
    default: {
      const bonus =
        safeNumber(candidate.damage_estimate) * 0.45 +
        safeNumber(candidate.tempo_value) * 0.8 +
        safeMetaSlot(candidate, "tempo_gain_now") * 0.35
      if (bonus !== 0) {
        score += bonus
        reasons.push(`plan_tempo=+${bonus.toFixed(2)}`)
      }
      break
    }
  }

  if (
    plan.resource_policy === "strict" &&
    actionCase === "elementalTuning"
  ) {
    const penalty =
      safeMetaSlot(candidate, "retention_value_proxy") * 0.45 +
      safeMetaSlot(candidate, "setup_dependency_loss") * 0.4 +
      safeMetaSlot(candidate, "finisher_alignment_loss") * 0.3
    if (penalty !== 0) {
      score -= penalty
      reasons.push(`plan_strict=-${penalty.toFixed(2)}`)
    }
  }

  if (observation && plan.kind === "stabilize") {
    const hpGap =
      observation.derived.opp_role_integrity_score - observation.derived.self_role_integrity_score
    if (hpGap > 0) {
      score += Math.min(0.75, hpGap * 0.15)
      reasons.push("plan_hp_gap")
    }
  }

  return { score, reasons }
}

function deriveCombatWindowMacroPlan(
  selection: CombatWindowLibrarySelection | null,
): RuntimeMacroPlan | null {
  const best = selection?.matches[0]
  if (!best || best.final_score < 0.6) {
    return null
  }
  const plan = best.entry.combat_window_plan
  const node =
    plan.nodes.find((item) => item.id === plan.entry_node_id) ??
    plan.nodes[0]
  if (!node) {
    return null
  }
  return {
    kind: mapNodeKindToMacroPlan(node.kind, node.prefer_tags),
    intent: node.intent,
    source: "combat_window",
    confidence: best.final_score,
    prefer_action_cases: node.expected_action_case ?? [],
    prefer_tags: [...node.prefer_tags],
    avoid_tags: [...node.avoid],
    resource_policy: node.resource_policy ?? "balanced",
    remaining_actions: Math.max(1, plan.plan_horizon.min_actions),
    active_node_id: node.id,
    library_tree_id: best.entry.tree_id,
  }
}

function shouldKeepPreviousPlan(
  plan: RuntimeMacroPlan | null,
  digest: PolicyTurnDigest,
  observation: ObservationV1 | null | undefined,
): boolean {
  if (!plan || plan.remaining_actions <= 0) {
    return false
  }
  if (plan.kind === "stabilize") {
    const activeHpRatio = currentSelfActiveHpRatio(digest)
    return activeHpRatio <= 0.7 || (observation?.derived.self_role_integrity_score ?? 0) <= 1
  }
  return true
}

function buildHeuristicMacroPlan(
  digest: PolicyTurnDigest,
  observation: ObservationV1 | null | undefined,
): RuntimeMacroPlan {
  const activeHpRatio = currentSelfActiveHpRatio(digest)
  const selfSetup = observation?.derived.self_setup_window_score ?? 0
  const oppSetup = observation?.derived.opp_setup_window_score ?? 0
  const selfBurst = observation?.derived.self_burst_online_count ?? 0
  const selfReaction = observation?.derived.self_reaction_ready_score ?? 0
  const round = Number(digest.round ?? 0)
  const selfRoleIntegrity = observation?.derived.self_role_integrity_score ?? 0
  const oppRoleIntegrity = observation?.derived.opp_role_integrity_score ?? 0

  // H7: Character count adaptation — 2-character strategy mode
  const selfAliveCount = observation?.self.characters.filter(c => c.alive).length ?? 3
  const oppAliveCount = observation?.opponent.characters.filter(c => c.alive).length ?? 3

  if (selfAliveCount === 2) {
    const shouldAggro = oppAliveCount <= 2 || activeHpRatio >= 0.5

    if (shouldAggro) {
      return {
        kind: "tempo_pressure",
        intent: "two_char_aggro_push",
        source: "heuristic",
        confidence: 0.7,
        prefer_action_cases: ["useSkill", "switchActive"],
        prefer_tags: ["direct_damage", "skill_type:burst"],
        avoid_tags: ["effectless", "support_create"],
        resource_policy: "aggressive",
        remaining_actions: 2,
      }
    } else {
      return {
        kind: "stabilize",
        intent: "two_char_survive_push",
        source: "heuristic",
        confidence: 0.65,
        prefer_action_cases: ["useSkill", "playCard", "switchActive"],
        prefer_tags: ["healing", "survive", "direct_damage"],
        avoid_tags: ["effectless"],
        resource_policy: "balanced",
        remaining_actions: 3,
      }
    }
  }

  // Dynamic threshold: stabilize threshold adapts to game state
  const stabilizeThreshold = computeDynamicStabilizeThreshold(observation, round)
  // Dynamic remaining_actions based on plan kind and observation
  const burstRemainingActions = Math.max(1, selfBurst + 1)

  if (activeHpRatio <= stabilizeThreshold) {
    const stabilizeRemaining = Math.max(1, Math.ceil((1 - activeHpRatio) * 4))
    return {
      kind: "stabilize",
      intent: "preserve_board_and_survive",
      source: "heuristic",
      confidence: computeDynamicConfidence("stabilize", activeHpRatio, selfRoleIntegrity),
      prefer_action_cases: ["useSkill", "playCard", "switchActive"],
      prefer_tags: ["healing", "survive"],
      avoid_tags: ["declareEnd"],
      resource_policy: "strict",
      remaining_actions: stabilizeRemaining,
    }
  }

  if (selfBurst > 0) {
    return {
      kind: "burst_convert",
      intent: "cash_in_finisher_window",
      source: "heuristic",
      confidence: computeDynamicConfidence("burst_convert", selfBurst, oppRoleIntegrity),
      prefer_action_cases: ["useSkill", "playCard"],
      prefer_tags: ["burst_enable", "direct_damage", "skill_type:burst"],
      avoid_tags: ["effectless"],
      resource_policy: "aggressive",
      remaining_actions: burstRemainingActions,
    }
  }

  if (selfReaction > 0.75) {
    const reactionRemaining = round <= 2 ? 3 : 2
    return {
      kind: "reaction_convert",
      intent: "convert_reaction_window",
      source: "heuristic",
      confidence: computeDynamicConfidence("reaction_convert", selfReaction, oppRoleIntegrity),
      prefer_action_cases: ["useSkill", "playCard"],
      prefer_tags: ["reaction_enable", "direct_damage"],
      avoid_tags: ["declareEnd"],
      resource_policy: "balanced",
      remaining_actions: reactionRemaining,
    }
  }

  if (selfSetup >= oppSetup || earlyRound(digest)) {
    const setupRemaining = round <= 1 ? 3 : 2
    return {
      kind: "board_setup",
      intent: "build_reusable_window",
      source: "heuristic",
      confidence: computeDynamicConfidence("board_setup", selfSetup, oppSetup),
      prefer_action_cases: ["playCard", "useSkill"],
      prefer_tags: ["support_create", "summon_create", "dice_fix"],
      avoid_tags: ["effectless"],
      resource_policy: "balanced",
      remaining_actions: setupRemaining,
    }
  }

  return {
    kind: "tempo_pressure",
    intent: "preserve_initiative_and_push_damage",
    source: "heuristic",
    confidence: 0.5,
    prefer_action_cases: ["useSkill", "playCard", "switchActive"],
    prefer_tags: ["direct_damage", "energy_gain"],
    avoid_tags: ["declareEnd"],
    resource_policy: "balanced",
    remaining_actions: 1,
  }
}

function computeDynamicStabilizeThreshold(
  observation: ObservationV1 | null | undefined,
  round: number,
): number {
  let base = 0.45
  if (round >= 6) base = 0.5
  if (round >= 8) base = 0.55
  const selfRoleIntegrity = observation?.derived.self_role_integrity_score ?? 0
  const oppRoleIntegrity = observation?.derived.opp_role_integrity_score ?? 0
  const integrityGap = oppRoleIntegrity - selfRoleIntegrity
  if (integrityGap > 1) base += 0.05
  if (integrityGap > 2) base += 0.05
  return Math.min(0.6, base)
}

function computeDynamicConfidence(
  kind: string,
  primarySignal: number,
  secondarySignal: number,
): number {
  switch (kind) {
    case "stabilize": {
      const hpFactor = Math.max(0, 1 - primarySignal)
      return Math.min(0.9, 0.5 + hpFactor * 0.4 + Math.min(0.2, secondarySignal * 0.05))
    }
    case "burst_convert": {
      const burstFactor = Math.min(1, primarySignal / 2)
      return Math.min(0.85, 0.55 + burstFactor * 0.3)
    }
    case "reaction_convert": {
      const reactionFactor = Math.min(1, primarySignal)
      return Math.min(0.8, 0.5 + reactionFactor * 0.3)
    }
    case "board_setup": {
      return Math.min(0.75, 0.45 + Math.min(0.3, primarySignal * 0.1))
    }
    default:
      return 0.5
  }
}

function mapNodeKindToMacroPlan(
  kind: string,
  preferTags: readonly string[],
): RuntimeMacroPlan["kind"] {
  switch (kind) {
    case "setup":
      return "board_setup"
    case "burst":
      return "burst_convert"
    case "survive":
      return "stabilize"
    case "convert":
      return preferTags.includes("reaction_enable")
        ? "reaction_convert"
        : "tempo_pressure"
    default:
      return "tempo_pressure"
  }
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

function earlyRound(digest: PolicyTurnDigest): boolean {
  return Number(digest.round ?? 0) <= 2
}

function candidateTagSet(candidate: PolicyCandidateAction): Set<string> {
  const tags = Array.isArray(candidate.tags) ? candidate.tags.map(String) : []
  return new Set([String(candidate.action_case ?? "unknown"), ...tags])
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
