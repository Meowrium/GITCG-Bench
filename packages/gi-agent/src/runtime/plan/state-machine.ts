// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type { ObservationV1 } from "@gi-tcg/ml/contracts"
import type { PolicyCandidateAction } from "../policy/types.js"
import { matchAnyPattern } from "./pattern-matcher.js"
import type {
  ActionPattern,
  AnyCondition,
  Condition,
  DiceReservationBudget,
  PlanPhase,
  ReplanAction,
  SPLContext,
  ThreatBonusEntry,
  ThreatRule,
  V2Condition,
  V2PlanPhase,
} from "./types.js"

/**
 * State data that the StrategicPlanStateMachine tracks across rounds.
 */
export interface PlanStateMachineState {
  /** All compiled phases for this deck */
  phases: PlanPhase[]
  /** Index of the current active phase */
  currentPhaseIndex: number
  /** Round of the current decision point */
  round: number
  /** Whether the plan has deviated beyond recovery */
  deviated: boolean
  /** Tags accumulated from observations */
  phaseTags: Set<string>
}

/**
 * Input state snapshot for a single update step.
 */
export interface PlanUpdateInput {
  round: number
  selfCharacters: Array<{
    id: number
    hp: number
    maxHp: number
    energy: number
    maxEnergy: number
    defeated: boolean
    definitionId?: number
  }>
  opponentCharacters: Array<{
    id: number
    hp: number
    maxHp: number
    energy: number
    maxEnergy: number
    defeated: boolean
    definitionId?: number
  }>
  summons: Array<{ characterId: number }>
  dice: Record<string, number>
  handCardIds: number[]

  // ── V2 Framework additional fields ──
  opponentDeclaredEnd?: boolean
  selfActiveCharacterId?: number | null
  selfAuras?: Array<{ id: number; aura: number | null }>
  opponentAuras?: Array<{ id: number; aura: number | null }>
  handCardTags?: Record<number, string[]>
}

/**
 * StrategicPlanStateMachine — the runtime engine that drives phase
 * transitions, threat detection, and SPL context generation.
 *
 * Usage:
 *   const sm = new StrategicPlanStateMachine(phases)
 *   const ctx = sm.update(inputs)  // called at each decision point
 *   // pass ctx to policy via PolicyDecisionContext
 */
export class StrategicPlanStateMachine {
  private state: PlanStateMachineState

  constructor(phases: PlanPhase[]) {
    this.state = {
      phases,
      currentPhaseIndex: 0,
      round: 0,
      deviated: false,
      phaseTags: new Set(),
    }
  }

  /**
   * Update the state machine with the latest game state and return
   * an SPLContext that the policy layer can consume.
   */
  update(input: PlanUpdateInput): SPLContext {
    // Advance the round counter
    this.state.round = input.round

    // Try to transition to a more appropriate phase
    this.evaluatePhaseTransition(input)

    const currentPhase = this.getCurrentPhase()

    // Detect active threats
    const threatBonusMap = this.evaluateThreats(currentPhase, input)

    // Build the SPL context
    return {
      phaseId: currentPhase.phaseId,
      phaseWeightsOverrides: [currentPhase.weightOverrides],
      threatBonusMap,
      actionBanList: currentPhase.actionPriorities.banned,
      diceBudget: currentPhase.diceBudget,
      primaryPatterns: currentPhase.actionPriorities.primary,
    }
  }

  /**
   * Check whether any banned pattern matches a candidate.
   */
  isBanned(candidate: PolicyCandidateAction): boolean {
    const currentPhase = this.getCurrentPhase()
    return matchAnyPattern(currentPhase.actionPriorities.banned, candidate)
  }

  /**
   * Get the current active phase (handles deviated state).
   */
  getCurrentPhase(): PlanPhase {
    if (this.state.deviated) {
      // Find emergency recovery phase
      const recovery = this.state.phases.find((p) => p.phaseId === "emergency_recovery")
      if (recovery) return recovery
    }
    return this.state.phases[this.state.currentPhaseIndex] ?? this.state.phases[0]
  }

  /**
   * Mark the plan as deviated — triggers fallback phase.
   */
  markDeviated(): void {
    this.state.deviated = true
  }

  /**
   * ── V2: Check replan triggers ──
   * Returns the highest-priority replan action, or null if no trigger is active.
   */
  checkReplanTriggers(input: PlanUpdateInput): ReplanAction | null {
    const currentPhase = this.getCurrentPhase()
    const v2Phase = currentPhase as V2PlanPhase
    if (!v2Phase.replanTriggers || v2Phase.replanTriggers.length === 0) return null

    // Sort by priority (lower number = higher priority)
    const sorted = [...v2Phase.replanTriggers].sort((a, b) => a.priority - b.priority)

    for (const trigger of sorted) {
      const allMet = trigger.condition.every((c) => this.evaluateAnyCondition(c, input))
      if (allMet) {
        return {
          triggerId: trigger.id,
          phaseOverride: null,
          immediateActionHint: trigger.description,
        }
      }
    }

    return null
  }

  /**
   * Convenience: getReplanAction alias.
   */
  getReplanAction(input: PlanUpdateInput): ReplanAction | null {
    return this.checkReplanTriggers(input)
  }

  // ---------------------------------------------------------------------------
  // Private: Phase transition evaluation
  // ---------------------------------------------------------------------------

  private evaluatePhaseTransition(input: PlanUpdateInput): void {
    const currentPhase = this.state.phases[this.state.currentPhaseIndex]
    if (!currentPhase) return

    // Check if current phase's completion conditions are met
    const allComplete = currentPhase.completionConditions.length > 0 &&
      currentPhase.completionConditions.every((c) => this.evaluateCondition(c, input))

    if (allComplete) {
      this.tryAdvancePhase(input)
      return
    }

    // Check if we're outside the turn range for the current phase
    if (input.round < currentPhase.turnRange.min || input.round > currentPhase.turnRange.max) {
      this.tryAdvancePhase(input)
      return
    }

    // Check if we should skip to a later phase based on preconditions
    for (let i = this.state.currentPhaseIndex + 1; i < this.state.phases.length; i++) {
      const candidate = this.state.phases[i]
      if (!candidate) continue
      if (candidate.preconditions.every((c) => this.evaluateCondition(c, input))) {
        this.state.currentPhaseIndex = i
        return
      }
    }
  }

  private tryAdvancePhase(input: PlanUpdateInput): void {
    const nextIndex = this.state.currentPhaseIndex + 1
    if (nextIndex >= this.state.phases.length) return

    const nextPhase = this.state.phases[nextIndex]
    if (!nextPhase) return

    if (nextPhase.preconditions.every((c) => this.evaluateCondition(c, input))) {
      this.state.currentPhaseIndex = nextIndex
      return
    }

    // Try fallback
    const fallback = this.state.phases[nextIndex].fallbackPhaseId
    if (fallback) {
      const fallbackPhase = this.state.phases.find((p) => p.phaseId === fallback)
      if (fallbackPhase && fallbackPhase.preconditions.every((c) => this.evaluateCondition(c, input))) {
        this.state.currentPhaseIndex = this.state.phases.indexOf(fallbackPhase)
        return
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Condition evaluation
  // ---------------------------------------------------------------------------

  /**
   * Evaluate any condition (both base Condition and V2Condition).
   */
  private evaluateAnyCondition(condition: AnyCondition, input: PlanUpdateInput): boolean {
    if (this.isV2Condition(condition)) {
      return this.evaluateV2Condition(condition, input)
    }
    return this.evaluateCondition(condition as Condition, input)
  }

  private isV2Condition(c: AnyCondition): c is V2Condition {
    return [
      "element_aura",
      "opponent_declared_end",
      "self_has_element",
      "opponent_characters_alive_count",
      "all_opponents_have_aura",
      "self_active_character_is",
      "self_has_card_in_hand_with_tag",
    ].includes(c.type)
  }

  private evaluateCondition(condition: Condition, input: PlanUpdateInput): boolean {
    switch (condition.type) {
      case "summon_active":
        return input.summons.some((s) => s.characterId === condition.characterId)

      case "character_energy": {
        const ch = findCharacter(input.selfCharacters, condition.characterId)
        return ch != null && ch.energy >= condition.minEnergy
      }

      case "character_hp": {
        const ch = findCharacter(input.selfCharacters, condition.characterId)
        return ch != null && ch.hp >= condition.minHp
      }

      case "character_hp_below": {
        const ch = findCharacter(input.selfCharacters, condition.characterId)
        return ch != null && ch.hp <= condition.maxHp
      }

      case "card_in_hand":
        return input.handCardIds.includes(condition.cardId)

      case "dice_count": {
        const available = sumDiceForElement(input.dice, condition.element)
        return available >= condition.min
      }

      case "round_gte":
        return input.round >= condition.round

      case "round_lt":
        return input.round < condition.round

      case "opponent_energy": {
        return input.opponentCharacters.some((ch) =>
          !ch.defeated && ch.energy >= condition.minEnergy,
        )
      }

      case "opponent_character_alive":
        return input.opponentCharacters.some(
          (ch) => ch.id === condition.characterId && !ch.defeated,
        )

      case "any_opponent_full_energy":
        return input.opponentCharacters.some(
          (ch) => !ch.defeated && ch.energy >= ch.maxEnergy,
        )

      case "any_self_full_energy":
        return input.selfCharacters.some(
          (ch) => !ch.defeated && ch.energy >= ch.maxEnergy,
        )

      case "defeated_count": {
        const defeated = input.selfCharacters.filter((ch) => ch.defeated).length
        return defeated >= condition.min
      }

      case "character_defeated":
        return input.selfCharacters.some(
          (ch) => ch.id === condition.characterId && ch.defeated,
        )

      default: {
        const _exhaustive: never = condition
        return false
      }
    }
  }

  /**
   * ── V2: Evaluate extended condition types ──
   */
  private evaluateV2Condition(condition: V2Condition, input: PlanUpdateInput): boolean {
    switch (condition.type) {
      case "element_aura": {
        const char = input.selfCharacters.find((c) => c.id === condition.characterId)
          ?? input.opponentCharacters.find((c) => c.id === condition.characterId)
        if (!char || char.defeated) return false
        const selfAura = input.selfAuras?.find((a) => a.id === condition.characterId)
        const oppAura = input.opponentAuras?.find((a) => a.id === condition.characterId)
        const aura = selfAura ?? oppAura
        return aura != null && aura.aura === condition.aura
      }

      case "opponent_declared_end":
        return input.opponentDeclaredEnd === true

      case "self_has_element": {
        return input.selfCharacters.some((ch) => {
          if (ch.defeated) return false
          const aura = input.selfAuras?.find((a) => a.id === ch.id)
          return aura != null && aura.aura !== null && aura.aura > 0
        })
      }

      case "opponent_characters_alive_count":
        return input.opponentCharacters.filter((ch) => !ch.defeated).length >= condition.min

      case "all_opponents_have_aura": {
        const alive = input.opponentCharacters.filter((ch) => !ch.defeated)
        if (alive.length === 0) return false
        return alive.every((ch) => {
          const aura = input.opponentAuras?.find((a) => a.id === ch.id)
          return aura != null && aura.aura === condition.aura
        })
      }

      case "self_active_character_is": {
        if (input.selfActiveCharacterId == null) return false
        return input.selfActiveCharacterId === condition.characterId
      }

      case "self_has_card_in_hand_with_tag": {
        if (!input.handCardTags) return false
        return Object.values(input.handCardTags).some(
          (tags) => tags.includes(condition.tag),
        )
      }

      default: {
        const _exhaustive: never = condition
        return false
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Threat evaluation
  // ---------------------------------------------------------------------------

  private evaluateThreats(
    phase: PlanPhase,
    input: PlanUpdateInput,
  ): Map<string, ThreatBonusEntry> {
    const map = new Map<string, ThreatBonusEntry>()

    for (const rule of phase.threatRules) {
      if (this.evaluateCondition(rule.threat, input)) {
        for (const pattern of rule.priorityActions) {
          map.set(rule.threatId + ":" + JSON.stringify(pattern), {
            pattern,
            multiplier: rule.bonusMultiplier,
          })
        }
      }
    }

    return map
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findCharacter(
  chars: PlanUpdateInput["selfCharacters"] | PlanUpdateInput["opponentCharacters"],
  characterId: number,
): PlanUpdateInput["selfCharacters"][0] | undefined {
  return chars.find((ch) => ch.id === characterId)
}

function sumDiceForElement(
  dice: Record<string, number>,
  element: string,
): number {
  if (element === "any" || element === "omni") {
    return Object.values(dice).reduce((a, b) => a + b, 0)
  }
  return (dice[element] ?? 0) + (dice["omni"] ?? 0)
}
