// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * Strategic Plan Layer (SPL) Core Types
 *
 * Bridges the gap between Skill-based declarative strategy analysis
 * (from deck-analyzer) and the procedural action-scoring pipeline.
 *
 * A PlanPhase describes the objectives, constraints, and priorities
 * for a named phase of the game. The StrategicPlanStateMachine
 * manages phase transitions and produces tactical overrides consumed
 * by BaselinePolicy/GiMlPolicy at each decision point.
 */

// ---------------------------------------------------------------------------
// Condition predicates — evaluated against game state to drive phase
// transitions and threat detection.
// ---------------------------------------------------------------------------

export type Condition =
  | { type: "summon_active"; characterId: number }
  | { type: "character_energy"; characterId: number; minEnergy: number }
  | { type: "character_hp"; characterId: number; minHp: number }
  | { type: "character_hp_below"; characterId: number; maxHp: number }
  | { type: "card_in_hand"; cardId: number }
  | { type: "dice_count"; element: string; min: number }
  | { type: "round_gte"; round: number }
  | { type: "round_lt"; round: number }
  | { type: "opponent_energy"; minEnergy: number }
  | { type: "opponent_character_alive"; characterId: number }
  | { type: "any_opponent_full_energy" }
  | { type: "any_self_full_energy" }
  | { type: "defeated_count"; min: number }
  | { type: "character_defeated"; characterId: number }

// ── V2 Framework: Extended Condition Types ──

/** Element aura on a character (0 = none, see AuraType enum) */
export type AuraType = number

export type V2Condition =
  | { type: "element_aura"; characterId: number; aura: AuraType }
  | { type: "opponent_declared_end" }
  | { type: "self_has_element"; element: string }
  | { type: "opponent_characters_alive_count"; min: number }
  | { type: "all_opponents_have_aura"; aura: AuraType }
  | { type: "self_active_character_is"; characterId: number }
  | { type: "self_has_card_in_hand_with_tag"; tag: string }

export type AnyCondition = Condition | V2Condition

// ---------------------------------------------------------------------------
// ActionPattern — describes a category of candidate action for
// priority boosting, banning, or matching.
// ---------------------------------------------------------------------------

export type ActionPattern =
  | { type: "play_card"; cardId: number }
  | { type: "play_card_class"; cardClass: CardClass }
  | { type: "use_skill"; skillId: number }
  | { type: "use_skill_of"; characterId: number }
  | { type: "switch_to"; characterId: number }
  | { type: "normal_attack"; characterId: number }
  | { type: "elemental_skill"; characterId: number }
  | { type: "elemental_burst"; characterId: number }
  | { type: "declare_end" }
  | { type: "elemental_tuning" }
  | { type: "play_card_tag"; tag: string }

export type CardClass = "weapon" | "artifact" | "support" | "event" | "food" | "talent" | "arcane"

// ---------------------------------------------------------------------------
// Dice budget — reserved dice for high-priority actions later in the turn.
// ---------------------------------------------------------------------------

export interface DiceReservationBudget {
  /** Element to reserve ("cryo", "electro", "omni", "any") */
  element: string
  /** Number of dice to reserve */
  count: number
  /** Human-readable description of the purpose */
  purpose: string
  /** 1 = must keep, 2 = suggested, 3 = breakable */
  priority: number
}

// ---------------------------------------------------------------------------
// Threat detection & response
// ---------------------------------------------------------------------------

export interface ThreatRule {
  /** A stable id for this threat rule (used in threatBonusMap keys) */
  threatId: string
  /** Condition that signals the threat is active */
  threat: Condition
  /** Priority actions when threat is active */
  priorityActions: ActionPattern[]
  /** Multiplier bonus applied to matching candidates when threat is active */
  bonusMultiplier: number
  /** Human-readable explanation */
  description: string
}

export interface ThreatBonusEntry {
  pattern: ActionPattern
  multiplier: number
}

// ── V2 Framework: Extended Phase Types ──

/**
 * Dice bucket — a planned action's dice requirements for the current turn.
 * Implements the "骰子分桶法" from the V2 AI Decision Framework.
 */
export interface DiceBucket {
  /** Index in the planned action sequence */
  actionIndex: number
  /** The action case this bucket is for */
  actionCase: string
  /** Required dice: element → count mapping */
  requiredDice: Record<string, number>
  /** Human-readable purpose */
  purpose: string
  /** Priority of this bucket (1=critical, 2=important, 3=optional) */
  priority: number
}

/**
 * Result of allocating dice to buckets.
 */
export interface DiceAllocation {
  /** Whether all buckets can be satisfied */
  feasible: boolean
  /** Fitness score (0–1) — 1.0 = perfect match */
  fitness: number
  /** Allocated dice per bucket */
  bucketAllocations: Array<{
    bucket: DiceBucket
    matched: boolean
    deficit: number
  }>
  /** Suggested reroll targets (element → priority) */
  rerollSuggestions: Array<{ element: string; count: number; priority: number }>
}

/**
 * Phase transition trigger — documents/defines the condition for switching
 * from one phase to another, matching §2.2 of the V2 framework.
 */
export interface PhaseTransition {
  from: string
  to: string
  trigger: string     // human-readable condition description
  condition: AnyCondition[]
  immediateAction?: string  // recommended first action after transition
}

// ── Extended PlanPhase with V2 support ──

export interface V2PlanPhase extends PlanPhase {
  /** V2 phase node id (0-7, matching §3 decision nodes) */
  nodeId: number
  /** Phase transition definitions for this phase */
  transitions: PhaseTransition[]
  /** Replan triggers active during this phase */
  replanTriggers: ReplanTriggerDef[]
}

export interface ReplanTriggerDef {
  id: string
  condition: AnyCondition[]
  priority: number  // 0-4, matching §5.2
  description: string
}

export interface ReplanAction {
  triggerId: string
  phaseOverride: string | null
  immediateActionHint: string
}

export interface PhaseWeightsOverride {
  endTurnPenalty?: number
  riskWeight?: number
  reactionWeight?: number
  tempoWeight?: number
  costWeight?: number
  healingWeight?: number
  drawWeight?: number
  supportWeight?: number
  summonWeight?: number
  equipmentWeight?: number
  energyWeight?: number
  diceFixWeight?: number
  effectlessPenalty?: number
}

// ---------------------------------------------------------------------------
// PlanPhase — the core unit of a Strategic Plan.
// ---------------------------------------------------------------------------

export interface PlanPhase {
  /** Machine-readable phase id (e.g. "setup_summons", "mid_execution", "late_burst") */
  phaseId: string
  /** Human-readable phase name */
  name: string
  /** Round range constraint — phase only activates within these rounds */
  turnRange: { min: number; max: number }

  /** All preconditions must be satisfied to enter this phase */
  preconditions: Condition[]

  /** Completion conditions — when all satisfied, transition to next phase */
  completionConditions: Condition[]

  /** Action priority rules for this phase */
  actionPriorities: {
    /** High-priority patterns — matching candidates get a +bonus */
    primary: ActionPattern[]
    /** Medium-priority patterns */
    secondary: ActionPattern[]
    /** Banned patterns — matching candidates get score = -Infinity */
    banned: ActionPattern[]
  }

  /** Dice budget — dice that must be reserved for this phase */
  diceBudget: DiceReservationBudget[]

  /** Threat-response rules active during this phase */
  threatRules: ThreatRule[]

  /** Fallback phase id when plan deviates (null = no fallback) */
  fallbackPhaseId: string | null

  /** Per-phase weight overrides for heuristic scoring */
  weightOverrides: PhaseWeightsOverride

  /** Primary action bonus — added to matching candidates */
  primaryMatchBonus: number
}

// ---------------------------------------------------------------------------
// SPL context — the output of PlanStateMachine.update(), consumed by
// the policy layer at each decision point.
// ---------------------------------------------------------------------------

export interface SPLContext {
  /** Current phase id */
  phaseId: string
  /** Phase weight overrides to merge into the heuristic profile */
  phaseWeightsOverrides: PhaseWeightsOverride[]
  /** Map from threatId → bonus entries for active threats */
  threatBonusMap: Map<string, ThreatBonusEntry>
  /** Action patterns that are banned in the current phase */
  actionBanList: ActionPattern[]
  /** Dice budget for the current phase */
  diceBudget: DiceReservationBudget[]
  /** Primary action patterns (for prioritization) */
  primaryPatterns: ActionPattern[]
}

// ---------------------------------------------------------------------------
// Deck meta — lightweight opponent-aware classification, derived from
// DeckAnalysis during plan compilation and consumed at plan-load time by
// computeMatchupDelta() to generate extra threat rules.
// ---------------------------------------------------------------------------

export interface DeckMeta {
  /** Deck strength from DeckAnalysis (0–10) */
  strength: number
  /** Deck archetype */
  archetype: "aggro" | "control" | "combo" | "midrange"
  /** Deck speed classification */
  speed: "fast" | "medium" | "slow"
}
