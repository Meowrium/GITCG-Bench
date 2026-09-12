// Copyright (C) 2024-2025 Guyutongxue
//
// DeckActionPrior — V26 P0-1: Action-conditional deck/matchup prior
//
// Replaces the current side-level prior constant with per-action bonuses
// derived from deck archetype and matchup features.
//
// Core insight: different deck features imply different action preferences.
// A "support engine" deck should prefer playCard(support); a "reaction" deck
// should prefer skills that trigger reactions; a "tempo push" deck should
// prefer aggressive skills in early rounds.

import type { DeckPriorFeatureVector } from "./prior-types.js"
import type { PolicyCandidateAction } from "./types.js"

export interface DeckActionPriorConfig {
  /** Overall weight multiplier for deck prior contribution */
  weight: number
  /** Maximum contribution per candidate to prevent runaway scores */
  maxContribution: number
}

export const DEFAULT_DECK_ACTION_PRIOR_CONFIG: DeckActionPriorConfig = {
  weight: 1.0,
  maxContribution: 2.0,
}

export interface DeckActionPriorResult {
  score: number
  reasons: string[]
}

/**
 * Compute action-conditional deck prior bonus.
 *
 * Derived rules (V26 §4):
 * - selfDeckSupportReliance high → bonus for playCard(support)
 * - selfDeckReactionReliance high → bonus for useSkill with reaction
 * - selfDeckTempoPush high → bonus for aggressive useSkill in R1/R2
 * - selfArchetypeSupportEngine → bonus for ramp/draw/econ actions
 * - matchupPunishGreedySetupDelta → penalize support plays vs anti-support
 * - matchupAntiSupportDelta → penalize support plays vs support-hate
 * - selfRouteReaction → bonus for reaction-enabling skills
 * - selfRouteResource → bonus for dice-generation / econ actions
 * - selfRouteCarry → bonus for high-damage skills
 */
export function scoreDeckActionPrior(
  features: DeckPriorFeatureVector,
  candidate: PolicyCandidateAction,
  round: number,
  config: DeckActionPriorConfig = DEFAULT_DECK_ACTION_PRIOR_CONFIG,
): DeckActionPriorResult {
  const reasons: string[] = []
  let raw = 0

  const ac = String(candidate.action_case ?? "")
  const tags = Array.isArray(candidate.tags)
    ? candidate.tags.map(String)
    : []
  const isSupport = ac === "playCard" && tags.some(t => t.includes("support"))
  const isSkill = ac === "useSkill"
  const isBurst = isSkill && tags.some(t => t.includes("burst") || t.includes("elementalBurst"))
  const hasReaction = (candidate.reaction_value ?? 0) > 0
  const damage = candidate.damage_estimate ?? 0
  const isEarlyRound = round <= 2

  // ── Self-deck archetype bonuses ──

  // Support engine deck: prefer support cards and support skills
  if (features.selfArchetypeSupportEngine > 0.3 && isSupport) {
    const bonus = features.selfArchetypeSupportEngine * 0.4
    raw += bonus
    reasons.push(`prior:support_engine=+${bonus.toFixed(2)}`)
  }

  // Support reliance: bonus for support play (but discounted if matchup punishes support)
  if (features.selfDeckSupportReliance > 0.3 && isSupport) {
    const punishFactor = Math.max(0, 1 - features.matchupPunishGreedySetupDelta * 2)
    const bonus = features.selfDeckSupportReliance * 0.3 * punishFactor
    if (bonus > 0.01) {
      raw += bonus
      reasons.push(`prior:support_rely=+${bonus.toFixed(2)}(punish=${(1-punishFactor).toFixed(2)})`)
    }
  }

  // Reaction reliance: bonus for skills that trigger reactions
  if (features.selfDeckReactionReliance > 0.3 && isSkill && hasReaction) {
    const bonus = features.selfDeckReactionReliance * 0.4
    raw += bonus
    reasons.push(`prior:reaction_rely=+${bonus.toFixed(2)}`)
  }

  // Tempo push: bonus for aggressive skills in early rounds
  if (features.selfDeckTempoPush > 0.3 && isSkill && damage >= 2 && isEarlyRound) {
    const bonus = features.selfDeckTempoPush * 0.3
    raw += bonus
    reasons.push(`prior:tempo_push=+${bonus.toFixed(2)}(r${round})`)
  }

  // Finisher density: bonus for burst skills (high damage finishers)
  if (features.selfDeckFinisherDensity > 0.3 && isBurst) {
    const bonus = features.selfDeckFinisherDensity * 0.5
    raw += bonus
    reasons.push(`prior:finisher=+${bonus.toFixed(2)}`)
  }

  // Equipment reliance: bonus for equipment plays
  if (features.selfDeckEquipmentReliance > 0.3 && ac === "playCard" && tags.some(t => t.includes("equipment") || t.includes("artifact") || t.includes("weapon"))) {
    const bonus = features.selfDeckEquipmentReliance * 0.3
    raw += bonus
    reasons.push(`prior:equipment_rely=+${bonus.toFixed(2)}`)
  }

  // Summon reliance: bonus for summon-creating skills
  if (features.selfDeckSummonReliance > 0.3 && isSkill && tags.some(t => t.includes("summon"))) {
    const bonus = features.selfDeckSummonReliance * 0.3
    raw += bonus
    reasons.push(`prior:summon_rely=+${bonus.toFixed(2)}`)
  }

  // ── Route bonuses ──

  // Reaction route: bonus for reaction-enabling elemental skills
  if (features.selfRouteReaction > 0.3 && isSkill && !isBurst) {
    const bonus = features.selfRouteReaction * 0.2
    raw += bonus
    reasons.push(`prior:route_reaction=+${bonus.toFixed(2)}`)
  }

  // Resource route: bonus for econ / dice generation actions
  if (features.selfRouteResource > 0.3) {
    const isDiceGen = (candidate.dice_fix_value ?? 0) > 0
      || tags.some(t => t.includes("dice") || t.includes("economy") || t.includes("draw"))
    if (isDiceGen || (isSupport && tags.some(t => t.includes("location") || t.includes("ally")))) {
      const bonus = features.selfRouteResource * 0.25
      raw += bonus
      reasons.push(`prior:route_resource=+${bonus.toFixed(2)}`)
    }
  }

  // Carry route: bonus for high-damage skills
  if (features.selfRouteCarry > 0.3 && isSkill && damage >= 3) {
    const bonus = features.selfRouteCarry * 0.3
    raw += bonus
    reasons.push(`prior:route_carry=+${bonus.toFixed(2)}`)
  }

  // ── Defensive/deck stability ──

  // Defensive stability: bonus for healing/switch when under pressure
  if (features.selfDeckDefensiveStability > 0.3) {
    const isDefensive = ac === "switchActive"
      || (candidate.healing_estimate ?? 0) > 0
      || tags.some(t => t.includes("shield") || t.includes("heal"))
    if (isDefensive) {
      const bonus = features.selfDeckDefensiveStability * 0.15
      raw += bonus
      reasons.push(`prior:defensive=+${bonus.toFixed(2)}`)
    }
  }

  // Long game value: bonus for value-generating setup in early game
  if (features.selfDeckLongGameValue > 0.3 && isEarlyRound && isSupport) {
    const bonus = features.selfDeckLongGameValue * 0.2
    raw += bonus
    reasons.push(`prior:long_game=+${bonus.toFixed(2)}`)
  }

  // ── Matchup-specific adjustments ──

  // Anti-support matchup: penalize support plays
  if (features.matchupAntiSupportDelta > 0.3 && isSupport) {
    const penalty = -features.matchupAntiSupportDelta * 0.5
    raw += penalty
    reasons.push(`prior:anti_support=${penalty.toFixed(2)}`)
  }

  // Anti-summon matchup: penalize summon-creating skills
  if (features.matchupAntiSummonDelta > 0.3 && isSkill && tags.some(t => t.includes("summon"))) {
    const penalty = -features.matchupAntiSummonDelta * 0.4
    raw += penalty
    reasons.push(`prior:anti_summon=${penalty.toFixed(2)}`)
  }

  // Route conflict: if matchup punishes our preferred route, reduce
  if (features.matchupRouteConflictScore > 0.3) {
    const penalty = -features.matchupRouteConflictScore * 0.3
    raw += penalty
    reasons.push(`prior:route_conflict=${penalty.toFixed(2)}`)
  }

  // Apply weight and clamp
  const weighted = raw * config.weight
  const clamped = Math.max(
    -config.maxContribution,
    Math.min(config.maxContribution, weighted),
  )

  return { score: clamped, reasons }
}
