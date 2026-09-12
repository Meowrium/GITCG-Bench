// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * ── V2 Framework: Risk Model (§6) ──
 *
 * Four-dimensional risk assessment used at every decision point:
 *   1. 斩杀暴露度 — 己方角色 HP / 对方最大单次爆发伤害
 *   2. 元素反制风险 — 对方是否有克制己方出战角色的元素
 *   3. 抢先手风险 — 对方剩余骰子 / 对方计划行动数
 *   4. 冻结锁可行性 — 对方存活角色全有水附着 AND 己方有冰角色
 *
 * Each dimension produces a numeric score and a human-readable flag.
 * The policy layer can use these to adjust risk appetite.
 */

import type { ObservationV1 } from "@gi-tcg/ml/contracts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RiskLevel = "safe" | "low" | "medium" | "high" | "critical"

export interface RiskDimension {
  /** Dimension name (matches §6.1) */
  name: string
  /** Numeric score (0 = safe, 1 = maximum risk) */
  score: number
  /** Human-readable level */
  level: RiskLevel
  /** Explanation of the risk */
  description: string
  /** Whether this risk requires immediate action */
  requiresAction: boolean
}

export interface RiskAssessment {
  /** Per-dimension assessment */
  dimensions: RiskDimension[]
  /** Overall risk score (max of all dimensions) */
  overallScore: number
  /** Overall risk level */
  overallLevel: RiskLevel
  /** Whether any risk requires action */
  anyRequiresAction: boolean
  /** Summary explanation */
  summary: string
}

// ---------------------------------------------------------------------------
// Element type mapping (for counter-checking)
// ---------------------------------------------------------------------------

/**
 * Counter-element mapping:
 *   pyro → cryo (melt counter)
 *   hydro → electro (electro-charged)
 *   electro → geo (crystallize)
 *   cryo → pyro (melt counter)
 *   anemo → none (can swirl anything)
 *   geo → none (can crystallize anything)
 */
function getElementCounters(element: string): string[] {
  switch (element) {
    case "pyro": return ["cryo", "hydro"]
    case "hydro": return ["electro", "cryo"]  // freeze is dangerous
    case "cryo": return ["pyro"]  // melt
    case "electro": return ["cryo"]  // superconduct
    default: return []
  }
}

const AURA_TO_ELEMENT: Record<number, string> = {
  1: "cryo",
  2: "hydro",
  3: "pyro",
  4: "electro",
  5: "anemo",
  6: "geo",
  7: "dendro",
}

// ---------------------------------------------------------------------------
// Risk assessment function
// ---------------------------------------------------------------------------

/**
 * Compute the full four-dimensional risk assessment from the current
 * game observation.
 */
export function computeRiskAssessment(observation: ObservationV1): RiskAssessment {
  const dimensions: RiskDimension[] = [
    computeExposureRisk(observation),
    computeCounterRisk(observation),
    computeTempoRisk(observation),
    computeFreezeLockFeasibility(observation),
  ]

  const overallScore = Math.max(...dimensions.map((d) => d.score))
  const overallLevel = scoreToLevel(overallScore)
  const anyRequiresAction = dimensions.some((d) => d.requiresAction)

  const highRisks = dimensions.filter((d) => d.level === "high" || d.level === "critical")
  let summary: string
  if (highRisks.length === 0) {
    summary = "All risk dimensions within safe thresholds"
  } else {
    summary = `Active risks: ${highRisks.map((d) => d.name).join(", ")}`
  }

  return {
    dimensions,
    overallScore,
    overallLevel,
    anyRequiresAction,
    summary,
  }
}

// ---------------------------------------------------------------------------
// Dimension 1: 斩杀暴露度 (Exposure Danger)
// §6.1: self HP / opponent max burst damage < 1.5 → dangerous
// ---------------------------------------------------------------------------

function computeExposureRisk(observation: ObservationV1): RiskDimension {
  const selfActive = observation.self.characters.find((c) => c.is_active && c.alive)
  if (!selfActive) {
    return {
      name: "exposure_danger",
      score: 0.5,
      level: "medium",
      description: "No active character — risk unclear",
      requiresAction: false,
    }
  }

  const oppChars = observation.opponent.characters.filter((c) => c.alive)
  let maxOppBurst = 0
  for (const opp of oppChars) {
    // Estimate max burst damage from observation
    // A burst typically deals 3-8 damage
    if (opp.energy >= opp.max_energy) {
      // Burst ready — estimate based on typical burst damage (conservative)
      maxOppBurst = Math.max(maxOppBurst, opp.energy >= opp.max_energy ? 6 : 3)
    } else {
      // Check if they have enough energy for a significant attack
      const energyRatio = opp.max_energy > 0 ? opp.energy / opp.max_energy : 0
      if (energyRatio > 0.5) {
        maxOppBurst = Math.max(maxOppBurst, 4)
      }
    }
  }

  // Also check for high-damage summons
  const oppSummons = observation.opponent.summons
  if (oppSummons.length > 0) {
    maxOppBurst = Math.max(maxOppBurst, 2)  // summons typically deal 1-2
  }

  const hp = selfActive.health
  const ratio = maxOppBurst > 0 ? hp / maxOppBurst : 99

  let score: number
  let level: RiskLevel
  let description: string
  let requiresAction: boolean

  if (ratio < 1.0) {
    score = 1.0
    level = "critical"
    description = `Active character (HP=${hp}) will die to opponent burst (est. ${maxOppBurst}dmg)`
    requiresAction = true
  } else if (ratio < 1.5) {
    score = 0.75
    level = "high"
    description = `Active character (HP=${hp}) in danger — within opponent burst range (est. ${maxOppBurst}dmg)`
    requiresAction = true
  } else if (ratio < 3.0) {
    score = 0.4
    level = "medium"
    description = `Active character (HP=${hp}) has moderate buffer vs opponent (est. ${maxOppBurst}dmg)`
    requiresAction = false
  } else {
    score = 0.1
    level = "safe"
    description = `Active character (HP=${hp}) safe from burst (est. ${maxOppBurst}dmg)`
    requiresAction = false
  }

  return { name: "exposure_danger", score, level, description, requiresAction }
}

// ---------------------------------------------------------------------------
// Dimension 2: 元素反制风险 (Element Counter Risk)
// §6.1: binary — whether opponent has a character that counters our active
// ---------------------------------------------------------------------------

function computeCounterRisk(observation: ObservationV1): RiskDimension {
  const selfActive = observation.self.characters.find((c) => c.is_active && c.alive)
  if (!selfActive) {
    return {
      name: "element_counter",
      score: 0,
      level: "safe",
      description: "No active character",
      requiresAction: false,
    }
  }

  const selfAura = selfActive.aura
  if (selfAura == null) {
    return {
      name: "element_counter",
      score: 0,
      level: "safe",
      description: "No aura on active character",
      requiresAction: false,
    }
  }

  const selfElement = AURA_TO_ELEMENT[selfAura]
  if (!selfElement) {
    return {
      name: "element_counter",
      score: 0,
      level: "safe",
      description: "Unknown aura element",
      requiresAction: false,
    }
  }

  const counters = getElementCounters(selfElement)
  const oppChars = observation.opponent.characters.filter((c) => c.alive)

  // Check if any opponent character can apply a counter element
  // We use their aura as a proxy for what element they can use
  let hasCounter = false
  let counterElement = ""
  for (const opp of oppChars) {
    if (opp.aura != null) {
      const oppElement = AURA_TO_ELEMENT[opp.aura]
      if (oppElement && counters.includes(oppElement)) {
        hasCounter = true
        counterElement = oppElement
        break
      }
    }
  }

  if (hasCounter) {
    return {
      name: "element_counter",
      score: 0.6,
      level: "medium",
      description: `Opponent can counter ${selfElement} with ${counterElement}`,
      requiresAction: false,
    }
  }

  return {
    name: "element_counter",
    score: 0,
    level: "safe",
    description: "No element counter",
    requiresAction: false,
  }
}

// ---------------------------------------------------------------------------
// Dimension 3: 抢先手风险 (Tempo Loss Risk)
// §6.1: opponent remaining dice / opponent planned actions > 2 → high
// ---------------------------------------------------------------------------

function computeTempoRisk(observation: ObservationV1): RiskDimension {
  const oppDice = observation.opponent.dice
  const oppTotalDice = oppDice.total_count
  
  const oppActionCount = observation.point.action_count_in_round
  const estimatedOppActions = Math.max(1, oppActionCount)

  const ratio = oppTotalDice / estimatedOppActions

  let score: number
  let level: RiskLevel
  let description: string
  let requiresAction: boolean

  if (ratio > 3) {
    score = 0.8
    level = "high"
    description = `Opponent has ${oppTotalDice}dice vs ~${estimatedOppActions} remaining actions — high tempo`
    requiresAction = true
  } else if (ratio > 2) {
    score = 0.5
    level = "medium"
    description = `Opponent has moderate tempo advantage (${oppTotalDice}dice / ${estimatedOppActions} actions)`
    requiresAction = false
  } else if (ratio > 1) {
    score = 0.2
    level = "low"
    description = `Opponent tempo manageable (${oppTotalDice}dice / ${estimatedOppActions} actions)`
    requiresAction = false
  } else {
    score = 0
    level = "safe"
    description = `No tempo advantage (${oppTotalDice}dice / ${estimatedOppActions} actions)`
    requiresAction = false
  }

  return { name: "tempo_loss", score, level, description, requiresAction }
}

// ---------------------------------------------------------------------------
// Dimension 4: 冻结锁可行性 (Freeze Lock Feasibility)
// §6.1: binary — all opponents have hydro aura AND self has cryo character
// ---------------------------------------------------------------------------

function computeFreezeLockFeasibility(observation: ObservationV1): RiskDimension {
  const oppAlive = observation.opponent.characters.filter((c) => c.alive)
  if (oppAlive.length === 0) {
    return {
      name: "freeze_lock",
      score: 0,
      level: "safe",
      description: "No opponents alive",
      requiresAction: false,
    }
  }

  // Check all alive opponents have hydro aura
  const allHaveHydro = oppAlive.every((c) => c.aura === 2)  // aura 2 = hydro
  // Check self has a cryo character alive
  const hasCryoChar = observation.self.characters.some(
    (c) => c.alive && !c.is_active,  // cryo character (not necessarily active)
  )

  // Also check if any self character definition_id is a known cryo character
  const cryoDefinitionIds = [1101, 1102, 1103, 1104, 1105, 1106, 1107, 1108]
  const hasKnownCryo = observation.self.characters.some(
    (c) => c.alive && cryoDefinitionIds.includes(c.definition_id),
  )

  const freezeLockPossible = allHaveHydro && (hasCryoChar || hasKnownCryo)

  if (freezeLockPossible) {
    return {
      name: "freeze_lock",
      score: 0.3,
      level: "low",
      description: "Freeze lock feasible — all opponents have hydro, self has cryo",
      requiresAction: false,
    }
  }

  return {
    name: "freeze_lock",
    score: 0,
    level: "safe",
    description: "Freeze lock not feasible",
    requiresAction: false,
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function scoreToLevel(score: number): RiskLevel {
  if (score >= 0.8) return "critical"
  if (score >= 0.6) return "high"
  if (score >= 0.35) return "medium"
  if (score >= 0.15) return "low"
  return "safe"
}
