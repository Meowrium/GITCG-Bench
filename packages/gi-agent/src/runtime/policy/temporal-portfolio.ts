// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * Temporal Option Portfolio — online evaluator.
 *
 * Models the current game state as a collection of temporal options
 * (deferred payoffs, recurring engines, conditional synergies) and
 * estimates how each candidate action changes the portfolio EV.
 *
 * This replaces per-candidate rule scoring with a structural view:
 *   - What options are active/progressing/ready/blocked?
 *   - Does this action advance a progressing option?
 *   - Does this action lock us into too many delayed payoffs?
 *   - Does this action cash in a ready option?
 */

import type {
  TemporalCardProfile,
  TemporalPayoffVector,
} from "../../knowledge/temporal-profiles/types.js"
import {
  getProfile,
  getSynergyRequirements,
  loadProfiles,
} from "../../knowledge/temporal-profiles/profile-registry.js"
import { getStaticPriorForDefinitionId } from "../../learning/rl/static-priors.js"
import type { ObservationV1, PlayerObservationV1 } from "@gi-tcg/ml/contracts"
import type {
  PolicyCandidateAction,
  PolicyTurnDigest,
  RuntimeMacroPlan,
} from "./types.js"

// ── Types ──

export type OptionStatus =
  | "available"       // can be deployed but not yet active
  | "active"          // deployed, not yet ready to cash
  | "progressing"     // deployed, accumulating (e.g. Liben collecting dice)
  | "ready_to_cash"   // conditions met, payoff accessible
  | "expired"         // timing window passed (e.g. round 4 Liben)
  | "blocked"         // prerequisites not met

export interface TemporalOption {
  id: string
  sourceDefinitionId: number | null
  sourceEntityId: number | null
  status: OptionStatus
  kind: string
  triggerWindows: string[]
  prerequisites: string[]      // card tags required
  payoff: TemporalPayoffVector
  payoffDelay: number          // rounds until payoff
  payoffRecurrence: string     // "once" | "per_round" | "per_condition"
  footprint: {
    supportSlot: boolean
    diceCost: number
  }
  confidence: number           // 0-1: how certain we are about this option
}

export interface PortfolioAggregate {
  /** How saturated are our setup slots (0=empty, 1=full) */
  setupSaturation: number
  /** EV of delayed payoffs coming online soon */
  delayedPayoffEV: number
  /** EV of immediate conversion actions */
  conversionEV: number
  /** 0-1: how much pressure is on support slots */
  supportSlotPressure: number
  /** Count of deferred options that will conflict for slot space */
  deferredOptionCount: number
  /** Number of ready-to-cash options */
  readyToCashCount: number
  /** Number of blocked options (synergy missing) */
  blockedOptionCount: number
}

export interface OptionPortfolio {
  active: TemporalOption[]
  progressing: TemporalOption[]
  readyToCash: TemporalOption[]
  available: TemporalOption[]
  blocked: TemporalOption[]
  aggregate: PortfolioAggregate
}

export interface PortfolioDelta {
  score: number
  reasons: string[]
}

// ── Portfolio Builder ──

const MAX_SUPPORT_SLOTS = 4

/**
 * Build the current option portfolio from game state observation.
 */
export function buildOptionPortfolio(
  observation: ObservationV1 | null | undefined,
  digest: PolicyTurnDigest,
  macroPlan: RuntimeMacroPlan | null,
): OptionPortfolio {
  loadProfiles()

  const round = Number(digest.round ?? 0)
  const self = observation?.self
  const supports = self?.supports ?? []
  const summons = self?.summons ?? []
  const statuses = self?.combat_statuses ?? []
  const handCards = self?.hand.visible_cards ?? []

  // ── Active / progresssing / ready options from board entities ──
  const active: TemporalOption[] = []
  const progressing: TemporalOption[] = []
  const readyToCash: TemporalOption[] = []

  for (const entity of [...supports, ...summons, ...statuses]) {
    const defId = entity.definition_id
    if (defId == null) continue
    const profile = getProfile(defId)
    if (!profile) continue
    const option = buildOptionFromProfile(profile, defId, entity.id, "active", round)
    if (!option) continue

    // Determine readiness
    const isProgressing = profile.optionKind === "deferred_bank"

    if (isProgressing) {
      // For Liben-like options, we can't fully determine progress without
      // engine state. Heuristic: if on field, treat as progressing (might cash soon)
      option.status = "progressing"
      progressing.push(option)
    } else if (profile.optionKind === "recurring_engine") {
      // Recurring engines are always "ready" (they proc each round)
      option.status = "ready_to_cash"
      readyToCash.push(option)
    } else if (profile.optionKind === "burst_enabler") {
      option.status = "ready_to_cash"
      readyToCash.push(option)
    } else {
      option.status = "active"
      active.push(option)
    }
  }

  // ── Available / blocked options from hand ──
  const available: TemporalOption[] = []
  const blocked: TemporalOption[] = []

  for (const card of handCards) {
    const defId = card.definition_id
    if (defId == null) continue
    const profile = getProfile(defId)
    if (!profile) continue

    // Skip non-setup cards (damage/heal events)
    if (!["deferred_bank", "recurring_engine", "conditional_engine", "burst_enabler"].includes(profile.optionKind)) {
      continue
    }

    const option = buildOptionFromProfile(profile, defId, card.entity_id, "available", round)
    if (!option) continue

    // Check prerequisites
    const synergyTags = getSynergyRequirements(defId)
    const allPrereqsSatisfied = synergyTags.every(tag =>
      hasSynergyTag(handCards, tag, defId) ||
      hasSynergyInCandidates(digest.candidate_actions, tag, defId) ||
      hasSynergyOnBoard(supports, summons, tag)
    )

    if (synergyTags.length > 0 && !allPrereqsSatisfied) {
      option.status = "blocked"
      option.confidence = 0.3
      blocked.push(option)
    } else {
      // Check round fit
      if (profile.lifecycle) {
        const deployMax = profile.lifecycle.ideal_deploy_round.max
        if (round > deployMax + 1) {
          option.status = "expired"
          // Don't add expired options
          continue
        }
      }
      available.push(option)
    }
  }

  // ── Also add candidate actions as "available" if they'd create a support ──
  for (const candidate of digest.candidate_actions) {
    if (candidate.action_case !== "playCard") continue
    const defId = safeNumber(candidate.card_definition_id)
    if (defId === 0) continue
    const profile = getProfile(defId)
    if (!profile) continue
    if (!["deferred_bank", "recurring_engine", "conditional_engine"].includes(profile.optionKind)) {
      continue
    }

    // Don't duplicate hand cards
    if (available.some(o => o.sourceDefinitionId === defId)) continue
    if (blocked.some(o => o.sourceDefinitionId === defId)) continue

    const option = buildOptionFromProfile(profile, defId, null, "available", round)
    if (!option) continue

    const synergyTags = getSynergyRequirements(defId)
    const allPrereqsSatisfied = synergyTags.length === 0 || synergyTags.every(tag =>
      hasSynergyTag(handCards, tag, defId) ||
      hasSynergyInCandidates(digest.candidate_actions, tag, defId) ||
      hasSynergyOnBoard(supports, summons, tag)
    )

    if (synergyTags.length > 0 && !allPrereqsSatisfied) {
      option.status = "blocked"
      option.confidence = 0.3
      blocked.push(option)
    } else {
      available.push(option)
    }
  }

  // ── Compute aggregate ──
  const supportCount = supports.length
  const setupSaturation = clamp(supportCount / MAX_SUPPORT_SLOTS, 0, 1)
  const deferredOptionCount = [...active, ...progressing, ...available]
    .filter(o => o.kind === "deferred_bank" || o.payoffDelay > 0)
    .length
  const supportSlotPressure = clamp(supportCount / MAX_SUPPORT_SLOTS, 0, 1)

  const delayedPayoffEV = progressing
    .reduce((sum, o) => sum + payoffEV(o) * o.confidence, 0)

  const conversionEV = readyToCash
    .reduce((sum, o) => sum + payoffEV(o) * o.confidence, 0)

  const aggregate: PortfolioAggregate = {
    setupSaturation,
    delayedPayoffEV,
    conversionEV,
    supportSlotPressure,
    deferredOptionCount,
    readyToCashCount: readyToCash.length,
    blockedOptionCount: blocked.length,
  }

  return { active, progressing, readyToCash, available, blocked, aggregate }
}

// ── Candidate Delta ──

/**
 * Estimate how a candidate action changes the portfolio EV.
 *
 * Positive delta = action advances the portfolio toward payoff.
 * Negative delta = action over-commits to setup, blocks better options, or
 *   deploys a blocked option.
 */
export function estimateCandidatePortfolioDelta(
  portfolio: OptionPortfolio,
  candidate: PolicyCandidateAction,
  digest: PolicyTurnDigest,
  macroPlan: RuntimeMacroPlan | null,
): PortfolioDelta {
  const actionCase = String(candidate.action_case ?? "")
  const defId = safeNumber(candidate.card_definition_id)
  const round = Number(digest.round ?? 0)
  const reasons: string[] = []
  let score = 0

  if (actionCase === "playCard" && defId > 0) {
    const profile = getProfile(defId)
    if (!profile) {
      // Fallback to tag-based heuristic when no profile available
      const { score: fallback, reasons: fallbackReasons } = scoreFallbackPortfolioDelta(
        portfolio, candidate, digest, macroPlan,
      )
      return { score: fallback, reasons: fallbackReasons }
    }

    // ── Support card deployment ──
    if (profile.footprint.support_slot) {
      // Blocked option penalty — check if the option exists in portfolio.blocked
      const isBlocked = portfolio.blocked.some(o => o.sourceDefinitionId === defId)
      const isAvailable = portfolio.available.some(o => o.sourceDefinitionId === defId)

      if (isBlocked) {
        const penalty = profile.optionKind === "conditional_engine" ? -0.4 : -0.2
        score += penalty
        reasons.push(`portfolio_synergy_blocked:${profile.name}=${penalty.toFixed(2)}`)
        return { score, reasons }
      }

      if (isAvailable) {
        // Synergy satisfied — check if it has card_tag prerequisites to give bonus
        if (profile.prerequisites.some(p => p.kind === "card_tag")) {
          score += 0.15
          reasons.push(`portfolio_synergy_ready:${profile.name}=+0.15`)
        }
      }

      // ── Dice opportunity cost ──
      // Penalize card play when its dice cost consumes budget that could
      // otherwise fund skills. Scaled by cost/available ratio: high-cost
      // cards like 派蒙(.costSame(3)) eat a full skill's worth of dice,
      // while 0-cost cards like 立本 pass through freely.
      // Source: cards/support/ally.ts — costs verified at .costSame(n) lines.
      const cardCost = profile.footprint.dice_cost_average
      const availableDice = safeNumber(digest.resource_summary.dice_count) || 8
      if (cardCost > 0 && availableDice > 0) {
        const diceRatio = cardCost / availableDice
        const penalty = -diceRatio * 0.3
        const roundFactor = round <= 2 ? 1.0 : 0.7
        const diceOppCost = Math.max(-0.08, penalty * roundFactor)  // weak prior; GBDT learns real weight
        if (diceOppCost < 0) {
          score += diceOppCost
          reasons.push(`portfolio_dice_opp=${diceOppCost.toFixed(2)}`)
        }
      }

      // Slot pressure check
      if (portfolio.aggregate.supportSlotPressure >= 0.75) {
        score -= 0.25
        reasons.push("portfolio_slot_pressure=-0.25")
      }

      // Density check: too many deferred options
      if (
        profile.optionKind === "deferred_bank" &&
        portfolio.aggregate.deferredOptionCount >= 2
      ) {
        const penalty = Math.min(0.4, 0.2 + (portfolio.aggregate.deferredOptionCount - 2) * 0.1)
        score -= penalty
        reasons.push(`portfolio_deferred_density=-${penalty.toFixed(2)}`)
      }

      // Round fitness
      if (profile.lifecycle) {
        if (round > profile.lifecycle.ideal_deploy_round.max) {
          score -= 0.18
          reasons.push(`portfolio_too_late:${profile.name}=-0.18`)
        } else if (round <= profile.lifecycle.ideal_deploy_round.min) {
          score += 0.08
          reasons.push(`portfolio_early_deploy:${profile.name}=+0.08`)
        }
      }

      // Duplicate prevention
      const duplicateOnBoard = portfolio.active.some(o => o.sourceDefinitionId === defId) ||
        portfolio.progressing.some(o => o.sourceDefinitionId === defId)
      if (duplicateOnBoard) {
        score -= 0.3
        reasons.push("portfolio_duplicate=-0.30")
      }

      return { score, reasons }
    }
  }

  // ── Conversion actions (useSkill / switchActive) ──
  if (actionCase === "useSkill" || actionCase === "switchActive") {
    const setupSaturated =
      portfolio.aggregate.setupSaturation >= 0.5 ||
      portfolio.aggregate.deferredOptionCount >= 2

    if (setupSaturated) {
      // Incentivize converting setup into damage/energy when slots are filling up
      if (actionCase === "useSkill") {
        const conversionValue = safeNumber(candidate.damage_estimate) * 0.04 +
          safeNumber(candidate.reaction_value) * 0.07 +
          safeNumber(candidate.energy_gain_value) * 0.03
        if (conversionValue > 0) {
          const bonus = Math.min(0.3, conversionValue)
          score += bonus
          reasons.push(`portfolio_cash_ready=+${bonus.toFixed(2)}`)
        }
      }

      if (actionCase === "switchActive" && portfolio.aggregate.readyToCashCount > 0) {
        score += 0.08
        reasons.push("portfolio_pivot_to_cash=+0.08")
      }
    }

    // Late game conversion pressure
    if (round >= 3) {
      const pressure = safeNumber(candidate.damage_estimate) * 0.03
      if (pressure > 0) {
        score += Math.min(0.15, pressure)
        reasons.push(`portfolio_late_convert=+${Math.min(0.15, pressure).toFixed(2)}`)
      }
    }

    return { score, reasons }
  }

  // ── DeclareEnd — assess cross-round risk ──
  if (actionCase === "declareEnd") {
    // If we have active progressing options and opponent hasn't ended,
    // ending might give them free window
    if (portfolio.progressing.length > 0 && !digest.opponent_declared_end) {
      // Small penalty if we have Liben-like options mid-progress
      // but don't penalize too heavily — this is already covered by tempo model
    }
    return { score: 0, reasons }
  }

  return { score: 0, reasons: [] }
}

// ── Fallback (no profile available) ──

function scoreFallbackPortfolioDelta(
  portfolio: OptionPortfolio,
  candidate: PolicyCandidateAction,
  digest: PolicyTurnDigest,
  macroPlan: RuntimeMacroPlan | null,
): PortfolioDelta {
  // Use tag-based heuristics when no profile exists
  const tags = new Set<string>([
    ...normalizeTags(candidate.tags),
    ...normalizeTags(candidate.static_effect_tags),
  ])
  const round = Number(digest.round ?? 0)
  const reasons: string[] = []
  let score = 0

  const isSupport = tags.has("support_create") || tags.has("card:support")
  const hasDeferred = tags.has("timing:endPhase") || tags.has("timing:actionPhase")

  if (isSupport && hasDeferred) {
    if (portfolio.aggregate.setupSaturation >= 0.75) {
      score -= 0.25
      reasons.push("portfolio_slot_pressure=-0.25")
    }
    if (portfolio.aggregate.deferredOptionCount >= 2) {
      score -= 0.3
      reasons.push(`portfolio_deferred_density=-0.30`)
    }
    if (round > 2) {
      score -= 0.12
      reasons.push("portfolio_late_setup=-0.12")
    }
  }

  return { score, reasons }
}

// ── Helpers ──

function buildOptionFromProfile(
  profile: TemporalCardProfile | null,
  definitionId: number,
  entityId: number | null,
  defaultStatus: OptionStatus,
  round: number,
): TemporalOption | null {
  if (!profile) return null

  // Round fitness
  if (profile.lifecycle) {
    if (round > profile.lifecycle.ideal_deploy_round.max + 2) return null
  }

  return {
    id: `opt_${definitionId}_${entityId ?? 'hand'}`,
    sourceDefinitionId: definitionId,
    sourceEntityId: entityId,
    status: defaultStatus,
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
    confidence: 0.7,
  }
}

function payoffEV(option: TemporalOption): number {
  let ev = 0
  if (option.payoff.draw) ev += option.payoff.draw * 0.5
  if (option.payoff.generate_dice_omni) ev += option.payoff.generate_dice_omni * 0.4
  if (option.payoff.generate_dice_elemental) ev += option.payoff.generate_dice_elemental * 0.3
  if (option.payoff.generate_dice_random) ev += option.payoff.generate_dice_random * 0.25
  if (option.payoff.energy_gain) ev += option.payoff.energy_gain * 0.4
  if (option.payoff.heal) ev += option.payoff.heal * 0.3
  if (option.payoff.cost_reduction) ev += option.payoff.cost_reduction * 0.2
  if (option.payoff.cost_reduction_all) ev += 0.5
  return ev
}

function hasSynergyTag(
  handCards: PlayerObservationV1["hand"]["visible_cards"],
  tag: string,
  excludeDefId: number,
): boolean {
  return handCards.some(card =>
    card.definition_id !== excludeDefId &&
    hasTag(card.tags, tag)
  )
}

function hasSynergyInCandidates(
  candidates: readonly PolicyCandidateAction[],
  tag: string,
  excludeDefId: number,
): boolean {
  return candidates.some(candidate => {
    if (candidate.action_case !== "playCard") return false
    const defId = safeNumber(candidate.card_definition_id)
    if (defId === excludeDefId || defId === 0) return false
    const allTags = new Set([
      ...normalizeTags(candidate.tags),
      ...normalizeTags(candidate.static_effect_tags),
      ...getStaticPriorForDefinitionId(defId).static_effect_tags,
    ])
    return hasTag([...allTags], tag)
  })
}

function hasSynergyOnBoard(
  supports: PlayerObservationV1["supports"],
  summons: PlayerObservationV1["summons"],
  tag: string,
): boolean {
  for (const entity of [...supports, ...summons]) {
    if (entity.definition_id == null) continue
    const prior = getStaticPriorForDefinitionId(entity.definition_id)
    if (prior.static_effect_tags.some(t => t === `tag:${tag}` || t === tag)) {
      return true
    }
  }
  return false
}

function hasSynergyInPortfolio(portfolio: OptionPortfolio, tag: string): boolean {
  // Check if any active/ready option provides this tag
  return [...portfolio.active, ...portfolio.readyToCash, ...portfolio.progressing]
    .some(o => {
      if (o.sourceDefinitionId == null) return false
      const prior = getStaticPriorForDefinitionId(o.sourceDefinitionId)
      return prior.static_effect_tags.some(t => t === `tag:${tag}` || t === tag)
    })
}

function hasTag(tags: string[], tag: string): boolean {
  return tags.some(t =>
    t === tag ||
    t === `tag:${tag}` ||
    t.startsWith(`category:${tag}`) ||
    t.startsWith(`card:${tag}`)
  )
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === "string") return [value]
  return []
}

function safeNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
