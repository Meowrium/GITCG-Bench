// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * ── V2 Framework: Lethal Chain Engine (§3.6-3.8) ──
 *
 * Searches for 2-4 step action sequences that can defeat one or more
 * opponent characters, accounting for:
 *   - Base skill damage
 *   - Elemental reaction bonuses (vaporize, melt, freeze → shatter, swirl AOE)
 *   - Dice budget feasibility
 *   - Resonance effects
 *
 * Core principle (§3.6):
 *   1. Calculate final damage → confirm kill
 *   2. Work backwards: each step's resource and damage
 *   3. Verify dice support the full chain
 *   4. Reserve 1 die margin
 */

import type { ObservationV1 } from "@gi-tcg/ml/contracts"
import type { PolicyCandidateAction, RankedPolicyCandidate } from "../policy/types.js"
import { matchReactionChainTemplates } from "./reaction-chain-templates.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single step in a lethal chain */
export interface LethalChainStep {
  /** Index in the action sequence */
  stepIndex: number
  /** The candidate action being evaluated */
  candidate: PolicyCandidateAction
  /** Action case name */
  actionName: string
  /** Character definition_id performing the action */
  actorDefinitionId: number
  /** Target character definition_id (if damage target) */
  targetDefinitionId: number | null
  /** Base damage before reactions */
  baseDamage: number
  /** Reaction bonus damage */
  reactionBonus: number
  /** Total damage this step deals to the primary target */
  totalDamage: number
  /** Swirl AOE damage to other opponents (if applicable) */
  aoeDamage: Record<number, number>
  /** Dice cost for this step */
  diceCost: number
  /** Whether a reaction was triggered this step */
  reactionTriggered: boolean
}

/** A complete lethal chain sequence */
export interface LethalChain {
  /** Primary target definition_id being eliminated */
  primaryTarget: number
  /** Secondary target definition_id (if chain targets multiple) */
  secondaryTarget: number | null
  /** Whether the chain is within current dice budget */
  isGuaranteed: boolean
  /** Total dice cost for the full chain */
  totalDiceCost: number
  /** Available dice count */
  availableDice: number
  /** Damage dealt to the primary target total */
  totalDamageToPrimary: number
  /** Damage dealt to secondary target (if any) */
  totalDamageToSecondary: number
  /** The steps in the chain, in execution order */
  steps: LethalChainStep[]
  /** Damage efficiency (total damage / total dice cost) */
  damagePerDie: number
  /** Whether this requires a character switch in the chain */
  requiresSwitch: boolean
  /** Whether this uses an energy transfer card (e.g. 白垩之术) */
  usesEnergyTransfer: boolean
  /** Human-readable chain description */
  description: string
}

// ---------------------------------------------------------------------------
// Aura → element mapping (matches GI TCG aura encoding)
// ---------------------------------------------------------------------------

const AURA_TO_ELEMENT: Record<number, string> = {
  1: "cryo",
  2: "hydro",
  3: "pyro",
  4: "electro",
  5: "anemo",
  6: "geo",
  7: "dendro",
}

const ELEMENT_TO_AURA: Record<string, number> = {
  cryo: 1,
  hydro: 2,
  pyro: 3,
  electro: 4,
  anemo: 5,
  geo: 6,
  dendro: 7,
}

// ---------------------------------------------------------------------------
// Reaction damage calculator
// ---------------------------------------------------------------------------

/**
 * Simplified GI TCG reaction damage bonuses.
 * These match the standard GI TCG ruleset:
 *   - Vaporize (hydro on pyro): +1
 *   - Vaporize (pyro on hydro): +2
 *   - Melt (cryo on pyro): +1
 *   - Melt (pyro on cryo): +2
 *   - Frozen: 0 (enables shatter)
 *   - Shatter (physical on frozen): +2
 *   - Swirl: AOE to other opponents (base damage of the element)
 *   - Overloaded: damage to next opponent
 *   - Superconduct: AOE to other opponents
 *   - Electro-Charged: AOE to other opponents
 */
export function computeReactionBonus(
  attackElement: string | null,
  targetAura: number | null,
): { bonus: number; aoe: boolean; reactionName: string } {
  if (!attackElement || targetAura == null) {
    return { bonus: 0, aoe: false, reactionName: "none" }
  }

  const auraElement = AURA_TO_ELEMENT[targetAura]
  if (!auraElement) return { bonus: 0, aoe: false, reactionName: "none" }

  // Vaporize
  if (attackElement === "pyro" && auraElement === "hydro") {
    return { bonus: 2, aoe: false, reactionName: "vaporize" }
  }
  if (attackElement === "hydro" && auraElement === "pyro") {
    return { bonus: 1, aoe: false, reactionName: "vaporize" }
  }

  // Melt
  if (attackElement === "pyro" && auraElement === "cryo") {
    return { bonus: 2, aoe: false, reactionName: "melt" }
  }
  if (attackElement === "cryo" && auraElement === "pyro") {
    return { bonus: 1, aoe: false, reactionName: "melt" }
  }

  // Frozen (no direct damage, enables shatter)
  if (attackElement === "cryo" && auraElement === "hydro") {
    return { bonus: 0, aoe: false, reactionName: "frozen" }
  }

  // Swirl (anemo + any element)
  if (attackElement === "anemo" && auraElement) {
    return { bonus: 1, aoe: true, reactionName: "swirl" }
  }

  // Overloaded (pyro + electro)
  if (attackElement === "pyro" && auraElement === "electro") {
    return { bonus: 2, aoe: false, reactionName: "overloaded" }
  }
  if (attackElement === "electro" && auraElement === "pyro") {
    return { bonus: 2, aoe: false, reactionName: "overloaded" }
  }

  // Superconduct (cryo + electro)
  if (attackElement === "cryo" && auraElement === "electro") {
    return { bonus: 1, aoe: true, reactionName: "superconduct" }
  }
  if (attackElement === "electro" && auraElement === "cryo") {
    return { bonus: 1, aoe: true, reactionName: "superconduct" }
  }

  // Electro-Charged (hydro + electro)
  if (attackElement === "hydro" && auraElement === "electro") {
    return { bonus: 1, aoe: true, reactionName: "electrocharged" }
  }
  if (attackElement === "electro" && auraElement === "hydro") {
    return { bonus: 1, aoe: true, reactionName: "electrocharged" }
  }

  return { bonus: 0, aoe: false, reactionName: "none" }
}

/**
 * Check if a candidate is a physical/normal attack on a frozen target → shatter bonus.
 */
export function computeShatterBonus(
  candidate: PolicyCandidateAction,
  targetAura: number | null,
): number {
  if (targetAura !== ELEMENT_TO_AURA["hydro"]) return 0  // frozen needs hydro aura
  
  // Check if this is a physical/normal attack that could trigger shatter
  const actionCase = (candidate.action_case ?? "").toLowerCase()
  if (actionCase.includes("normal") || actionCase.includes("普攻") || actionCase.includes("attack")) {
    // Check tags for physical damage
    const tags = candidate.tags ?? []
    const tagsArr = Array.isArray(tags) ? tags : [String(tags)]
    if (tagsArr.some((t) => String(t).includes("physical") || String(t).includes("aoe"))) {
      return 2  // shatter bonus
    }
    // Default: normal attacks are often physical
    return 2
  }
  return 0
}

// ---------------------------------------------------------------------------
// Aura propagation for multi-step chains
// ---------------------------------------------------------------------------

/**
 * Simulate aura state after an elemental attack hits a target.
 * 
 * Rules:
 * - If attack element reacts with current aura → aura is consumed (return null)
 * - Electrocharged exception: electro + hydro → electro aura remains
 * - No reaction → aura persists unchanged
 * - Physical/normal attack → aura persists
 */
export function propagateAura(
  currentAura: number | null,
  attackElement: string | null,
): number | null {
  if (!attackElement || currentAura == null) return currentAura

  const auraElement = AURA_TO_ELEMENT[currentAura]
  if (!auraElement) return currentAura

  // Electrocharged: electro remains after hydro+electro reaction
  if (attackElement === "electro" && auraElement === "hydro") {
    return ELEMENT_TO_AURA["electro"] ?? currentAura
  }
  if (attackElement === "hydro" && auraElement === "electro") {
    return ELEMENT_TO_AURA["hydro"] ?? currentAura
  }

  // Check if there's a reaction that consumes the aura
  const reaction = computeReactionBonus(attackElement, currentAura)
  if (reaction.reactionName !== "none") {
    // Aura consumed by reaction
    return null
  }

  // No reaction → aura persists
  return currentAura
}

// ---------------------------------------------------------------------------
// Element inference from candidates
// ---------------------------------------------------------------------------

/**
 * Infer the element type of a candidate action from its tags and action_case.
 */
function inferAttackElement(candidate: PolicyCandidateAction): string | null {
  const actionCase = (candidate.action_case ?? "").toLowerCase()
  const tags = candidate.tags ?? []
  const tagStrs = (Array.isArray(tags) ? tags : [String(tags)]).map(String)

  // Check tags first
  for (const tag of tagStrs) {
    const tl = tag.toLowerCase()
    if (tl.includes("pyro")) return "pyro"
    if (tl.includes("hydro")) return "hydro"
    if (tl.includes("cryo")) return "cryo"
    if (tl.includes("electro")) return "electro"
    if (tl.includes("anemo")) return "anemo"
    if (tl.includes("geo")) return "geo"
    if (tl.includes("dendro")) return "dendro"
  }

  // Check action_case
  if (actionCase.includes("anemo") || actionCase.includes("风")) return "anemo"
  if (actionCase.includes("hydro") || actionCase.includes("水")) return "hydro"
  if (actionCase.includes("pyro") || actionCase.includes("火")) return "pyro"
  if (actionCase.includes("cryo") || actionCase.includes("冰")) return "cryo"
  if (actionCase.includes("electro") || actionCase.includes("雷")) return "electro"
  if (actionCase.includes("geo") || actionCase.includes("岩")) return "geo"
  if (actionCase.includes("dendro") || actionCase.includes("草")) return "dendro"

  return null
}

// ---------------------------------------------------------------------------
// Dice cost extraction
// ---------------------------------------------------------------------------

function extractDiceCost(candidate: PolicyCandidateAction): number {
  const cost = candidate.dice_cost
  if (Array.isArray(cost)) {
    return cost.reduce((sum, entry) => sum + (Number((entry as Record<string, unknown>).count ?? 1)), 0)
  }
  return Number(candidate.total_cost ?? candidate.cost ?? 0)
}

// ---------------------------------------------------------------------------
// Main lethal chain search
// ---------------------------------------------------------------------------

/**
 * Search for lethal chains from the current set of candidate actions.
 *
 * Algorithm:
 *   1. Filter to damage-dealing candidates only
 *   2. Group by actor character
 *   3. For each group, try to build 2-4 step sequences
 *   4. For each sequence, compute total damage per target including reactions
 *   5. Verify dice budget
 *   6. Rank by damage efficiency
 */
export function computeLethalChains(
  observation: ObservationV1,
  candidates: PolicyCandidateAction[],
): LethalChain[] {
  const selfChars = observation.self.characters
  const oppChars = observation.opponent.characters.filter((c) => c.alive)

  if (oppChars.length === 0) return []

  // Filter to damage-dealing candidates (skills, bursts, normal attacks)
  const damagingCandidates = candidates.filter((c) => {
    const ac = (c.action_case ?? "").toLowerCase()
    const isSkill = ac.includes("skill") || ac.includes("burst") || ac.includes("normal") ||
                    ac.includes("attack") || ac.includes("e") || ac.includes("q") ||
                    ac.includes("elemental") || ac.includes("普攻") || ac.includes("战技") || ac.includes("大招")
    const hasDamage = Number(c.damage_estimate ?? 0) > 0
    return isSkill && hasDamage && c.is_valid !== false
  })

  if (damagingCandidates.length === 0) return []

  const availableDice = observation.self.dice.total_count
  const chains: LethalChain[] = []

  // Group candidates by actor character (use target_ids[0] as proxy for actor)
  const byActor = new Map<number, PolicyCandidateAction[]>()
  for (const c of damagingCandidates) {
    const targetIds = c.target_ids ?? []
    const actorId = targetIds.length > 0 ? targetIds[0] : 0
    if (!byActor.has(actorId)) byActor.set(actorId, [])
    byActor.get(actorId)!.push(c)
  }

  // Check for reaction chain matches to inform search
  const reactionChainMatches = matchReactionChainTemplates(observation)

  // Build chains from candidate sequences
  for (const [, actorCandidates] of byActor) {
    // Try single-step lethal
    for (const candidate of actorCandidates) {
      const chain = evaluateSingleStepChain(
        candidate, observation, oppChars, availableDice,
      )
      if (chain) chains.push(chain)
    }

    // Try two-step chains (e.g., skill → burst)
    for (let i = 0; i < actorCandidates.length; i++) {
      for (let j = 0; j < actorCandidates.length; j++) {
        if (i === j) continue
        const chain = evaluateTwoStepChain(
          actorCandidates[i], actorCandidates[j],
          observation, oppChars, availableDice,
        )
        if (chain) chains.push(chain)
      }
    }

    // Try three-step chains (e.g., NA → skill → burst, or switch → skill → burst)
    // This is done more selectively to avoid combinatorial explosion
    if (actorCandidates.length >= 3) {
      for (let i = 0; i < Math.min(actorCandidates.length, 4); i++) {
        for (let j = 0; j < Math.min(actorCandidates.length, 4); j++) {
          if (j === i) continue
          for (let k = 0; k < Math.min(actorCandidates.length, 4); k++) {
            if (k === i || k === j) continue
            const chain = evaluateThreeStepChain(
              actorCandidates[i], actorCandidates[j], actorCandidates[k],
              observation, oppChars, availableDice,
            )
            if (chain) chains.push(chain)
          }
        }
      }
    }
  }

  // Check for energy transfer chains (e.g., 白垩之术 → burst)
  const energyTransferCandidates = candidates.filter((c) => {
    const ac = (c.action_case ?? "").toLowerCase()
    return ac.includes("energy") || ac.includes("transfer") || ac.includes("充能") || ac.includes("白垩")
  })

  if (energyTransferCandidates.length > 0) {
    for (const transfer of energyTransferCandidates) {
      for (const [, actorCandidates] of byActor) {
        for (const burstCandidate of actorCandidates) {
          const ac = (burstCandidate.action_case ?? "").toLowerCase()
          if (!ac.includes("burst") && !ac.includes("大招") && !ac.includes("q")) continue
          const chain = evaluateEnergyTransferChain(
            transfer, burstCandidate,
            observation, oppChars, availableDice,
          )
          if (chain) chains.push(chain)
        }
      }
    }
  }

  // Sort by damage efficiency, then by probability of kill
  chains.sort((a, b) => {
    // Prefer guaranteed kills
    if (a.isGuaranteed !== b.isGuaranteed) {
      return a.isGuaranteed ? -1 : 1
    }
    // Then by damage per die
    const effA = a.damagePerDie
    const effB = b.damagePerDie
    if (effB !== effA) return effB - effA
    // Then by fewer dice (more efficient)
    return a.totalDiceCost - b.totalDiceCost
  })

  // Return top chains, avoiding duplicates
  const seen = new Set<string>()
  return chains.filter((chain) => {
    const key = chain.description + "|" + chain.totalDiceCost
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 5)
}

// ---------------------------------------------------------------------------
// Chain evaluators
// ---------------------------------------------------------------------------

function evaluateSingleStepChain(
  candidate: PolicyCandidateAction,
  observation: ObservationV1,
  oppChars: typeof observation.opponent.characters,
  availableDice: number,
): LethalChain | null {
  const damage = Number(candidate.damage_estimate ?? 0)
  const diceCost = extractDiceCost(candidate)
  if (damage <= 0 || diceCost > availableDice) return null

  // Check each opponent to see if this one-shots them
  for (const opp of oppChars) {
    const reaction = computeReactionBonus(
      inferAttackElement(candidate),
      opp.aura,
    )
    const shatterBonus = computeShatterBonus(candidate, opp.aura)
    const totalDmg = damage + reaction.bonus + shatterBonus

    if (totalDmg >= opp.health) {
      const step: LethalChainStep = {
        stepIndex: 0,
        candidate,
        actionName: candidate.action_case ?? "unknown",
        actorDefinitionId: extractActorDefId(candidate, observation),
        targetDefinitionId: opp.definition_id,
        baseDamage: damage,
        reactionBonus: reaction.bonus + shatterBonus,
        totalDamage: totalDmg,
        aoeDamage: reaction.aoe ? computeSwirlAoe(opp, oppChars, totalDmg) : {},
        diceCost,
        reactionTriggered: reaction.bonus > 0 || shatterBonus > 0,
      }

      return {
        primaryTarget: opp.definition_id,
        secondaryTarget: null,
        isGuaranteed: diceCost <= availableDice - 1, // 1 die margin
        totalDiceCost: diceCost,
        availableDice,
        totalDamageToPrimary: totalDmg,
        totalDamageToSecondary: 0,
        steps: [step],
        damagePerDie: totalDmg / Math.max(1, diceCost),
        requiresSwitch: false,
        usesEnergyTransfer: false,
        description: `${opp.definition_id} one-shot: ${step.actionName} (${totalDmg}dmg / ${diceCost}dice)`,
      }
    }
  }

  return null
}

function evaluateTwoStepChain(
  c1: PolicyCandidateAction,
  c2: PolicyCandidateAction,
  observation: ObservationV1,
  oppChars: typeof observation.opponent.characters,
  availableDice: number,
): LethalChain | null {
  const dmg1 = Number(c1.damage_estimate ?? 0)
  const dmg2 = Number(c2.damage_estimate ?? 0)
  const cost1 = extractDiceCost(c1)
  const cost2 = extractDiceCost(c2)
  const totalCost = cost1 + cost2

  if (dmg1 <= 0 || dmg2 <= 0) return null
  if (totalCost > availableDice) return null

  for (const opp of oppChars) {
    const elem1 = inferAttackElement(c1)
    const elem2 = inferAttackElement(c2)

    // Step 1: apply damage + reaction
    const reaction1 = computeReactionBonus(elem1, opp.aura)
    const shatter1 = computeShatterBonus(c1, opp.aura)
    const postStep1Hp = opp.health - (dmg1 + reaction1.bonus + shatter1)

    // If already dead after step 1, single-step is better
    if (postStep1Hp <= 0) continue

    // Step 2: residual aura after step 1 (simulated via propagateAura)
    const auraAfterStep1 = propagateAura(opp.aura, elem1)
    const reaction2 = computeReactionBonus(elem2, auraAfterStep1)
    const shatter2 = computeShatterBonus(c2, auraAfterStep1)
    const totalDmg = dmg1 + dmg2 + reaction1.bonus + reaction2.bonus + shatter1 + shatter2

    if (totalDmg >= opp.health) {
      const steps: LethalChainStep[] = [
        {
          stepIndex: 0, candidate: c1,
          actionName: c1.action_case ?? "step1",
          actorDefinitionId: extractActorDefId(c1, observation),
          targetDefinitionId: opp.definition_id,
          baseDamage: dmg1, reactionBonus: reaction1.bonus + shatter1,
          totalDamage: dmg1 + reaction1.bonus + shatter1,
          aoeDamage: reaction1.aoe ? computeSwirlAoe(opp, oppChars, dmg1 + reaction1.bonus) : {},
          diceCost: cost1,
          reactionTriggered: reaction1.bonus > 0 || shatter1 > 0,
        },
        {
          stepIndex: 1, candidate: c2,
          actionName: c2.action_case ?? "step2",
          actorDefinitionId: extractActorDefId(c2, observation),
          targetDefinitionId: opp.definition_id,
          baseDamage: dmg2, reactionBonus: reaction2.bonus + shatter2,
          totalDamage: dmg2 + reaction2.bonus + shatter2,
          aoeDamage: reaction2.aoe ? computeSwirlAoe(opp, oppChars, dmg2 + reaction2.bonus) : {},
          diceCost: cost2,
          reactionTriggered: reaction2.bonus > 0 || shatter2 > 0,
        },
      ]

      return {
        primaryTarget: opp.definition_id,
        secondaryTarget: null,
        isGuaranteed: totalCost <= availableDice - 1,
        totalDiceCost: totalCost,
        availableDice,
        totalDamageToPrimary: totalDmg,
        totalDamageToSecondary: 0,
        steps,
        damagePerDie: totalDmg / Math.max(1, totalCost),
        requiresSwitch: false,
        usesEnergyTransfer: false,
        description: `${opp.definition_id} 2-step: ${steps.map((s) => s.actionName).join(" → ")} (${totalDmg}dmg / ${totalCost}dice)`,
      }
    }
  }

  return null
}

function evaluateThreeStepChain(
  c1: PolicyCandidateAction,
  c2: PolicyCandidateAction,
  c3: PolicyCandidateAction,
  observation: ObservationV1,
  oppChars: typeof observation.opponent.characters,
  availableDice: number,
): LethalChain | null {
  const dmgs = [c1, c2, c3].map((c) => Number(c.damage_estimate ?? 0))
  const costs = [c1, c2, c3].map((c) => extractDiceCost(c))
  const totalCost = costs.reduce((a, b) => a + b, 0)

  if (dmgs.some((d) => d <= 0)) return null
  if (totalCost > availableDice) return null

  for (const opp of oppChars) {
    const elems = [c1, c2, c3].map((c) => inferAttackElement(c))

    // Simulate aura progression through all three steps
    const auraAfterStep1 = propagateAura(opp.aura, elems[0])
    const auraAfterStep2 = propagateAura(auraAfterStep1, elems[1])

    const reactions = [
      computeReactionBonus(elems[0], opp.aura),
      computeReactionBonus(elems[1], auraAfterStep1),
      computeReactionBonus(elems[2], auraAfterStep2),
    ]
    const shatters = [
      computeShatterBonus(c1, opp.aura),
      computeShatterBonus(c2, auraAfterStep1),
      computeShatterBonus(c3, auraAfterStep2),
    ]

    const totalDmg = dmgs.reduce((sum, d, i) =>
      sum + d + reactions[i].bonus + shatters[i], 0)

    if (totalDmg >= opp.health) {
      const steps: LethalChainStep[] = [c1, c2, c3].map((c, i) => ({
        stepIndex: i,
        candidate: c,
        actionName: c.action_case ?? `step${i + 1}`,
        actorDefinitionId: extractActorDefId(c, observation),
        targetDefinitionId: opp.definition_id,
        baseDamage: dmgs[i],
        reactionBonus: reactions[i].bonus + shatters[i],
        totalDamage: dmgs[i] + reactions[i].bonus + shatters[i],
        aoeDamage: reactions[i].aoe ? computeSwirlAoe(opp, oppChars, dmgs[i] + reactions[i].bonus) : {},
        diceCost: costs[i],
        reactionTriggered: reactions[i].bonus > 0 || shatters[i] > 0,
      }))

      return {
        primaryTarget: opp.definition_id,
        secondaryTarget: null,
        isGuaranteed: totalCost <= availableDice - 1,
        totalDiceCost: totalCost,
        availableDice,
        totalDamageToPrimary: totalDmg,
        totalDamageToSecondary: 0,
        steps,
        damagePerDie: totalDmg / Math.max(1, totalCost),
        requiresSwitch: steps.length > 1 && steps[0].actorDefinitionId !== steps[1].actorDefinitionId,
        usesEnergyTransfer: false,
        description: `${opp.definition_id} 3-step: ${steps.map((s) => s.actionName).join(" → ")} (${totalDmg}dmg / ${totalCost}dice)`,
      }
    }
  }

  return null
}

function evaluateEnergyTransferChain(
  transferCandidate: PolicyCandidateAction,
  burstCandidate: PolicyCandidateAction,
  observation: ObservationV1,
  oppChars: typeof observation.opponent.characters,
  availableDice: number,
): LethalChain | null {
  const dmg = Number(burstCandidate.damage_estimate ?? 0)
  const costT = extractDiceCost(transferCandidate)
  const costB = extractDiceCost(burstCandidate)
  const totalCost = costT + costB

  if (dmg <= 0 || totalCost > availableDice) return null

  for (const opp of oppChars) {
    const elem = inferAttackElement(burstCandidate)
    const reaction = computeReactionBonus(elem, opp.aura)
    const shatter = computeShatterBonus(burstCandidate, opp.aura)
    const totalDmg = dmg + reaction.bonus + shatter

    if (totalDmg >= opp.health) {
      const steps: LethalChainStep[] = [
        {
          stepIndex: 0, candidate: transferCandidate,
          actionName: transferCandidate.action_case ?? "energy_transfer",
          actorDefinitionId: extractActorDefId(transferCandidate, observation),
          targetDefinitionId: null,
          baseDamage: 0, reactionBonus: 0, totalDamage: 0,
          aoeDamage: {}, diceCost: costT,
          reactionTriggered: false,
        },
        {
          stepIndex: 1, candidate: burstCandidate,
          actionName: burstCandidate.action_case ?? "burst",
          actorDefinitionId: extractActorDefId(burstCandidate, observation),
          targetDefinitionId: opp.definition_id,
          baseDamage: dmg, reactionBonus: reaction.bonus + shatter,
          totalDamage: totalDmg,
          aoeDamage: reaction.aoe ? computeSwirlAoe(opp, oppChars, totalDmg) : {},
          diceCost: costB,
          reactionTriggered: reaction.bonus > 0 || shatter > 0,
        },
      ]

      return {
        primaryTarget: opp.definition_id,
        secondaryTarget: null,
        isGuaranteed: totalCost <= availableDice - 1,
        totalDiceCost: totalCost,
        availableDice,
        totalDamageToPrimary: totalDmg,
        totalDamageToSecondary: 0,
        steps,
        damagePerDie: totalDmg / Math.max(1, totalCost),
        requiresSwitch: false,
        usesEnergyTransfer: true,
        description: `energy_transfer → burst: ${opp.definition_id} (${totalDmg}dmg / ${totalCost}dice)`,
      }
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractActorDefId(
  candidate: PolicyCandidateAction,
  observation: ObservationV1,
): number {
  const targetIds = candidate.target_ids ?? []
  if (targetIds.length > 0) {
    // Find character by character id from observation
    const char = observation.self.characters.find((c) => c.id === targetIds[0])
    if (char) return char.definition_id
  }
  // Fall back to active character
  const activeChar = observation.self.characters.find((c) => c.is_active)
  return activeChar?.definition_id ?? 0
}

interface OppChar {
  id: number
  definition_id: number
  alive: boolean
  aura: number | null
  health: number
}

function computeSwirlAoe(
  primaryOpp: OppChar,
  allOpps: OppChar[],
  baseDmg: number,
): Record<number, number> {
  const aoe: Record<number, number> = {}
  for (const opp of allOpps) {
    if (opp.id !== primaryOpp.id && opp.alive) {
      aoe[opp.definition_id] = Math.max(1, Math.floor(baseDmg / 3))
    }
  }
  return aoe
}
