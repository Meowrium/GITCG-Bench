// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * PortfolioSnapshot — extracts temporal option state from ObservationV1.
 *
 * This replaces heuristic option classification with observation-driven state:
 *   - Uses entity variables (e.g. Liben's "collected") to classify progressing vs ready
 *   - Extracts hand-available, board-active, board-progressing, board-ready, and blocked options
 *   - Computes slot pressure, deferred density, and expected future value
 */

import type { ObservationV1, PlayerObservationV1 } from "@gi-tcg/ml/contracts"
import type {
  TemporalCardProfile,
  TemporalPayoffVector,
} from "../../knowledge/temporal-profiles/types.js"
import { getProfile, getSynergyRequirements, loadProfiles } from "../../knowledge/temporal-profiles/profile-registry.js"
import { getStaticPriorForDefinitionId } from "../../learning/rl/static-priors.js"
import type { PolicyCandidateAction, PolicyTurnDigest } from "./types.js"

// ── Types ──

export type OptionStatus =
  | "available"
  | "active"
  | "progressing"
  | "ready_to_cash"
  | "expired"
  | "blocked"

export interface TemporalOptionInstance {
  id: string
  sourceDefinitionId: number | null
  sourceEntityId: number | null
  status: OptionStatus
  kind: string
  triggerWindows: string[]
  prerequisites: string[]
  payoff: TemporalPayoffVector
  payoffDelay: number
  payoffRecurrence: string
  footprint: {
    supportSlot: boolean
    diceCost: number
  }
  /** Entity variable progress for deferred options (e.g. Liben collected count) */
  variableProgress: Record<string, number>
  confidence: number
}

export interface PortfolioSnapshot {
  active: TemporalOptionInstance[]
  progressing: TemporalOptionInstance[]
  readyToCash: TemporalOptionInstance[]
  available: TemporalOptionInstance[]
  blocked: TemporalOptionInstance[]
  /** 0-1: support slot fill ratio */
  slotPressure: number
  /** EV of the current portfolio (payoff-weighted) */
  expectedFutureValue: number
  /** Count of deferred options (deferred_bank kind) */
  deferredCount: number
  /** Total support slots used (from observation, not inference) */
  supportSlotsUsed: number
}

const MAX_SUPPORT_SLOTS = 4

// ── Snapshot Builder ──

export function buildPortfolioSnapshot(
  observation: ObservationV1 | null | undefined,
  candidates?: readonly PolicyCandidateAction[],
): PortfolioSnapshot {
  loadProfiles()

  const round = observation?.point.round_number ?? 0
  const self = observation?.self
  const supports = self?.supports ?? []
  const handCards = self?.hand.visible_cards ?? []

  const active: TemporalOptionInstance[] = []
  const progressing: TemporalOptionInstance[] = []
  const readyToCash: TemporalOptionInstance[] = []
  const available: TemporalOptionInstance[] = []
  const blocked: TemporalOptionInstance[] = []

  // ── Board entities: classify by observation state ──
  for (const entity of supports) {
    const defId = entity.definition_id
    if (defId == null) continue
    const profile = getProfile(defId)
    if (!profile) continue

    const option = buildOptionInstance(profile, defId, entity.id, round)
    if (!option) continue

    // Use entity variables to determine actual progress.
    // Note: EntityObservationV1 exposes only the single visible variable
    // (visibleVarName); there is no per-entity sub-array on this contract.
    option.variableProgress = {}
    if (entity.variable_name != null && entity.variable_value != null) {
      option.variableProgress[entity.variable_name] = entity.variable_value
    }

    // Classify by variable state + profile kind
    const isDeferred = profile.optionKind === "deferred_bank"
    const isRecurring = profile.optionKind === "recurring_engine"

    if (isDeferred) {
      // Check if the deferred option's variable threshold is met
      const variableReq = profile.prerequisites.find(p => p.kind === "variable_at_least")
      if (variableReq) {
        // Prereq format: "var:collected>=3" or similar
        const parts = variableReq.value.match(/^(\w+)(>=?|<=?|===?)(\d+)$/)
        if (parts) {
          const varName = parts[1]
          const op = parts[2]
          const threshold = parseInt(parts[3], 10)
          const currentVal = option.variableProgress[varName] ?? 0
          const isReady =
            op.startsWith(">=") ? currentVal >= threshold :
            op.startsWith("<=") ? currentVal <= threshold :
            op.startsWith(">") ? currentVal > threshold :
            currentVal === threshold

          option.status = isReady ? "ready_to_cash" : "progressing"
          if (isReady) {
            readyToCash.push(option)
          } else {
            progressing.push(option)
          }
          continue
        }
      }
      // No variable prereq found — fallback to heuristic
      option.status = "progressing"
      progressing.push(option)
      option.confidence = 0.4  // Lower confidence without variable tracking
    } else if (isRecurring) {
      option.status = "ready_to_cash"
      readyToCash.push(option)
    } else {
      option.status = "active"
      active.push(option)
    }
  }

  // ── Hand: classify by prerequisites ──
  for (const card of handCards) {
    const defId = card.definition_id
    if (defId == null) continue
    const profile = getProfile(defId)
    if (!profile) continue

    // Skip non-setup card types
    const setupKinds = ["deferred_bank", "recurring_engine", "conditional_engine", "burst_enabler"]
    if (!setupKinds.includes(profile.optionKind)) continue

    const option = buildOptionInstance(profile, defId, card.entity_id, round)
    if (!option) continue

    // Check prerequisites from hand
    const synergyTags = getSynergyRequirements(defId)
    const allPrereqsSatisfied = synergyTags.length === 0 || synergyTags.every(tag =>
      hasTagInHand(handCards, tag, defId) ||
      hasSynergyInCandidates(candidates, tag, defId) ||
      hasSynergyOnBoard(supports, tag)
    )

    if (synergyTags.length > 0 && !allPrereqsSatisfied) {
      option.status = "blocked"
      option.confidence = 0.3
      blocked.push(option)
    } else {
      available.push(option)
    }
  }

  // ── Also classify candidate_actions as available/blocked
  // (for synergy detection across candidates, WITHOUT injecting current scoring candidate)
  if (candidates) {
    for (const candidate of candidates) {
      if (candidate.action_case !== "playCard") continue
      const defId = safeNumber(candidate.card_definition_id)
      if (defId === 0) continue
      const profile = getProfile(defId)
      if (!profile) continue
      const setupKinds = ["deferred_bank", "recurring_engine", "conditional_engine", "burst_enabler"]
      if (!setupKinds.includes(profile.optionKind)) continue

      // Don't duplicate hand cards
      if (available.some(o => o.sourceDefinitionId === defId)) continue
      if (blocked.some(o => o.sourceDefinitionId === defId)) continue

      const option = buildOptionInstance(profile, defId, null, round)
      if (!option) continue

      const synergyTags = getSynergyRequirements(defId)
      const allPrereqsSatisfied = synergyTags.length === 0 || synergyTags.every(tag =>
        hasTagInHand(handCards, tag, defId) ||
        hasSynergyInCandidates(candidates, tag, defId) ||
        hasSynergyOnBoard(supports, tag)
      )

      if (synergyTags.length > 0 && !allPrereqsSatisfied) {
        option.status = "blocked"
        option.confidence = 0.3
        blocked.push(option)
      } else {
        available.push(option)
      }
    }
  }

  // ── Compute summary metrics ──
  const supportSlotsUsed = supports.length
  const slotPressure = Math.min(1, supportSlotsUsed / MAX_SUPPORT_SLOTS)
  const deferredCount = [...active, ...progressing, ...available]
    .filter(o => o.kind === "deferred_bank" || o.payoffDelay > 0).length
  const expectedFutureValue =
    progressing.reduce((sum, o) => sum + computePayoffEV(o.payoff) * o.confidence, 0) +
    readyToCash.reduce((sum, o) => sum + computePayoffEV(o.payoff) * o.confidence, 0)

  return {
    active,
    progressing,
    readyToCash,
    available,
    blocked,
    slotPressure,
    expectedFutureValue,
    deferredCount,
    supportSlotsUsed,
  }
}

// ── Transition Estimator ──

export interface PortfolioTransitionEstimate {
  /** How much the portfolio EV changes after this action */
  deltaEV: number
  /** Resources consumed (dice, cards) */
  resourceCost: {
    dice: number
    cards: number
  }
  /** Slot pressure change: +1 = net new support, -1 = support removed */
  slotDelta: number
  /** Action risk assessment */
  risk: {
    /** Risk of giving opponent a free window */
    tempoRisk: number
    /** Risk of over-committing to deferred options */
    overCommitRisk: number
    /** Risk of wasting dice without immediate value */
    wasteRisk: number
  }
  reasons: string[]
}

export function estimatePortfolioTransition(
  snapshot: PortfolioSnapshot,
  candidate: PolicyCandidateAction,
  observation: ObservationV1 | null | undefined,
  digest?: PolicyTurnDigest,
): PortfolioTransitionEstimate {
  const actionCase = String(candidate.action_case ?? "")
  const defId = safeNumber(candidate.card_definition_id)
  const round = observation?.point.round_number ?? 0
  const reasons: string[] = []
  let deltaEV = 0
  const resourceCost = { dice: safeNumber((candidate as { required_cost?: Array<{ count: number }> }).required_cost?.reduce?.((s: number, c: {count: number}) => s + c.count, 0) ?? 0), cards: 0 }
  const slotDelta = 0
  const risk = { tempoRisk: 0, overCommitRisk: 0, wasteRisk: 0 }

  if (actionCase === "playCard" && defId > 0) {
    const profile = getProfile(defId)
    if (!profile) return { deltaEV: 0, resourceCost, slotDelta, risk, reasons }

    // Synergy penalty for blocked options — check against snapshot AND
    // against implicit candidate availability (card may not be in hand snapshot
    // if it arrived via a separate candidate resolution path)
    const isInAvailable = snapshot.available.some(o => o.sourceDefinitionId === defId)
    const hasSynergyPrereqs = profile.prerequisites.some(p => p.kind === "card_tag")
    const isInBlocked = snapshot.blocked.some(o => o.sourceDefinitionId === defId)
    if (isInBlocked) {
      deltaEV -= 0.4
      reasons.push(`portfolio_synergy_blocked:${profile.name}`)
      return { deltaEV, resourceCost, slotDelta, risk, reasons }
    }

    // ── Duplicate on board ── (check early but DON'T return — still need slot_pressure)
    const isDuplicate = snapshot.active.some(o => o.sourceDefinitionId === defId) ||
      snapshot.progressing.some(o => o.sourceDefinitionId === defId) ||
      snapshot.readyToCash.some(o => o.sourceDefinitionId === defId)
    if (isDuplicate) {
      deltaEV -= 0.3
      reasons.push("portfolio_duplicate")
    }

    // ── Slot pressure check ── (applies regardless of availability/duplicate)
    if (snapshot.slotPressure >= 0.75) {
      deltaEV -= 0.25
      reasons.push("portfolio_slot_pressure")
    }

    // If duplicate and no other redeeming factors, return early
    if (isDuplicate) {
      return { deltaEV, resourceCost, slotDelta, risk, reasons }
    }

    // ── Available deployment ──
    const isAvailable = snapshot.available.some(o => o.sourceDefinitionId === defId)

    // If card not in snapshot at all (not in hand), do inline synergy check
    // for cards that aren't in the snapshot's hand/board lists
    if (!isAvailable && !snapshot.blocked.some(o => o.sourceDefinitionId === defId)) {
      // Card arrived via candidate list, not hand. Check prerequisites inline.
      if (hasSynergyPrereqs) {
        const synergyTags = profile.prerequisites
          .filter(p => p.kind === "card_tag")
          .map(p => p.value)
        const handCards = observation?.self?.hand?.visible_cards ?? []
        const allSatisfied = synergyTags.every(tag =>
          hasTagInHand(handCards, tag, defId) ||
          hasSynergyOnBoard(observation?.self?.supports ?? [], tag) ||
          hasSynergyInCandidates(digest?.candidate_actions, tag, defId)
        )
        if (!allSatisfied) {
          deltaEV -= 0.4
          reasons.push(`portfolio_synergy_blocked:${profile.name}`)
          return { deltaEV, resourceCost, slotDelta, risk, reasons }
        }
        // Synergy satisfied — fall through to available scoring below
      }
      // No synergy prereqs OR synergy satisfied → treat as available for scoring
    }

    // Score as if available (includes the inline-resolved path above)
    if (isAvailable || (!isAvailable && !snapshot.blocked.some(o => o.sourceDefinitionId === defId))) {
      const optionEV = computePayoffEV(profile.payoff)
      deltaEV += optionEV * 0.3
      reasons.push(`portfolio_deploy_ev:${profile.name}=+${(optionEV * 0.3).toFixed(2)}`)

      // Synergy bonus: card has prerequisites AND they're satisfied
      if (profile.prerequisites.some(p => p.kind === "card_tag")) {
        deltaEV += 0.15
        reasons.push(`portfolio_synergy_ready:${profile.name}=+0.15`)
      }

      // Dice opportunity cost
      const cardCost = profile.footprint.dice_cost_average
      const availableDice = safeNumber((digest?.resource_summary as Record<string, unknown>)?.dice_count ?? observation?.self.dice.total_count) || 8
      if (cardCost > 0 && availableDice > 0) {
        const diceRatio = cardCost / availableDice
        const penalty = -diceRatio * 0.3
        const round = observation?.point.round_number ?? 0
        const roundFactor = round <= 2 ? 1.0 : 0.7
        const diceOppCost = Math.max(-0.08, penalty * roundFactor)
        if (diceOppCost < 0) {
          deltaEV += diceOppCost
          reasons.push(`portfolio_dice_opp=${diceOppCost.toFixed(2)}`)
        }
      }

      // Slot pressure penalty
      if (snapshot.slotPressure >= 0.75) {
        deltaEV -= 0.25
        reasons.push("portfolio_slot_pressure")
      }

      // Deferred density penalty
      if (profile.optionKind === "deferred_bank" && snapshot.deferredCount >= 2) {
        deltaEV -= 0.3
        reasons.push("portfolio_deferred_density")
      }

      // Round fitness
      if (profile.lifecycle && round > profile.lifecycle.ideal_deploy_round.max) {
        deltaEV -= 0.18
        reasons.push(`portfolio_too_late:${round}>${profile.lifecycle.ideal_deploy_round.max}`)
      }

      return { deltaEV, resourceCost, slotDelta, risk, reasons }
    }
  }

  // ── Conversion actions (useSkill / switchActive) ──
  if (actionCase === "useSkill") {
    const setupSaturated = snapshot.slotPressure >= 0.5 || snapshot.deferredCount >= 2
    if (setupSaturated) {
      const damageVal = safeNumber((candidate as Record<string, unknown>).damage_estimate) * 0.04
      const reactionVal = safeNumber((candidate as Record<string, unknown>).reaction_value) * 0.07
      deltaEV += Math.min(0.3, damageVal + reactionVal)
      if (damageVal + reactionVal > 0) reasons.push("portfolio_cash_ready")
    }
    if (round >= 3) {
      const pressureVal = safeNumber((candidate as Record<string, unknown>).damage_estimate) * 0.03
      deltaEV += Math.min(0.15, pressureVal)
      if (pressureVal > 0) reasons.push("portfolio_late_convert")
    }
  }

  // ── DeclareEnd ──
  if (actionCase === "declareEnd") {
    // Has ready-to-cash options that will be wasted
    if (snapshot.readyToCash.length > 0) {
      deltaEV -= 0.15 * snapshot.readyToCash.length
      reasons.push(`portfolio_wasted_cash:${snapshot.readyToCash.length}options`)
    }

    // Has unfinished progressing options
    if (snapshot.progressing.length > 0) {
      deltaEV -= 0.08 * snapshot.progressing.length
      reasons.push(`portfolio_wasted_progress:${snapshot.progressing.length}options`)
    }

    // Reward ending when no setup value and saturated
    if (snapshot.readyToCash.length === 0 && snapshot.progressing.length === 0) {
      if (snapshot.slotPressure < 0.25) {
        deltaEV += 0.10
        reasons.push("portfolio_safe_end")
      }
    }

    // Tempo risk: ending early when opponent has actions
    if (snapshot.deferredCount > 0 && round <= 2) {
      risk.tempoRisk = 0.2
    }
  }

  return { deltaEV, resourceCost, slotDelta, risk, reasons }
}

// ── Helpers ──

function buildOptionInstance(
  profile: TemporalCardProfile,
  definitionId: number,
  entityId: number | null,
  round: number,
): TemporalOptionInstance | null {
  if (profile.lifecycle && round > profile.lifecycle.ideal_deploy_round.max + 2) return null

  return {
    id: `opt_${definitionId}_${entityId ?? "hand"}`,
    sourceDefinitionId: definitionId,
    sourceEntityId: entityId,
    status: "available",
    kind: profile.optionKind,
    triggerWindows: profile.triggerWindows,
    prerequisites: profile.prerequisites.map(p =>
      p.kind === "card_tag" ? p.value : `${p.kind}:${p.value}`
    ),
    payoff: profile.payoff,
    payoffDelay: profile.lifecycle?.payoff_delay ?? 0,
    payoffRecurrence: profile.lifecycle?.payoff_recurrence ?? "once",
    footprint: {
      supportSlot: profile.footprint.support_slot,
      diceCost: profile.footprint.dice_cost_average,
    },
    variableProgress: {},
    confidence: 0.7,
  }
}

export function computePayoffEV(payoff: TemporalPayoffVector): number {
  let ev = 0
  if (payoff.draw) ev += payoff.draw * 0.5
  if (payoff.generate_dice_omni) ev += payoff.generate_dice_omni * 0.4
  if (payoff.generate_dice_elemental) ev += payoff.generate_dice_elemental * 0.3
  if (payoff.generate_dice_random) ev += payoff.generate_dice_random * 0.25
  if (payoff.energy_gain) ev += payoff.energy_gain * 0.4
  if (payoff.heal) ev += payoff.heal * 0.3
  if (payoff.cost_reduction) ev += payoff.cost_reduction * 0.2
  if (payoff.cost_reduction_all) ev += 0.5
  return ev
}

function hasTagInHand(
  handCards: PlayerObservationV1["hand"]["visible_cards"],
  tag: string,
  excludeDefId: number,
): boolean {
  return handCards.some(card =>
    card.definition_id !== excludeDefId &&
    card.tags?.some(t => t === tag || t === `tag:${tag}`)
  )
}

function hasSynergyInCandidates(
  candidates: readonly PolicyCandidateAction[] | undefined,
  tag: string,
  excludeDefId: number,
): boolean {
  if (!candidates) return false
  return candidates.some(candidate => {
    if (candidate.action_case !== "playCard") return false
    const defId = safeNumber(candidate.card_definition_id)
    if (defId === excludeDefId || defId === 0) return false
    const prior = getStaticPriorForDefinitionId(defId)
    return prior.static_effect_tags.some(t => t === tag || t === `tag:${tag}`)
  })
}

function hasSynergyOnBoard(
  supports: PlayerObservationV1["supports"],
  tag: string,
): boolean {
  return supports.some(entity => {
    if (entity.definition_id == null) return false
    const prior = getStaticPriorForDefinitionId(entity.definition_id)
    return prior.static_effect_tags.some(t => t === tag || t === `tag:${tag}`)
  })
}

function safeNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}
