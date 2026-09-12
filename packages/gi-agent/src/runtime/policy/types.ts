// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type { ObservationV1 } from "@gi-tcg/ml/contracts";
import type { GamePlanRuntimeState } from "./game-plan.js"
import type { OpponentModelState } from "./opponent-model.js"
import type { DiceReservationBudget, ThreatBonusEntry, ActionPattern, PhaseWeightsOverride, ReplanAction, DiceAllocation } from "../plan/types.js"
import type { LethalChain } from "./lethal-chain.js"
import type { RiskAssessment } from "./risk-model.js"

export type RuntimeMacroPlanKind =
  | "tempo_pressure"
  | "board_setup"
  | "reaction_convert"
  | "burst_convert"
  | "stabilize"

export interface RuntimeMacroPlan {
  kind: RuntimeMacroPlanKind
  intent: string
  source: "heuristic" | "combat_window"
  confidence: number
  prefer_action_cases: string[]
  prefer_tags: string[]
  avoid_tags: string[]
  resource_policy: "strict" | "balanced" | "aggressive"
  remaining_actions: number
  active_node_id?: string | null
  library_tree_id?: string | null
}

export interface RuntimeMacroPlanState {
  plan: RuntimeMacroPlan | null
  trace: string[]
}

export interface PolicyCandidateAction {
  candidate_id?: string;
  action_case?: string;
  damage_estimate?: number;
  reaction_value?: number;
  tempo_value?: number;
  survival_risk?: number;
  healing_estimate?: number;
  self_heal_value?: number;
  team_heal_value?: number;
  draw_value?: number;
  dice_fix_value?: number;
  energy_gain_value?: number;
  create_support_value?: number;
  create_summon_value?: number;
  create_equipment_value?: number;
  forced_switch_value?: number;
  self_switch_value?: number;
  card_definition_id?: number | null;
  card_id?: number | null;
  card_entity_type?: number | null;
  card_equipment_type?: number | null;
  target_ids?: number[];
  target_count?: number;
  will_be_effectless?: boolean;
  cost?: unknown;
  total_cost?: unknown;
  dice_cost?: unknown;
  tags?: unknown;
  static_effect_tags?: unknown;
  meta_effect_slots?: unknown;
  synergy_slots?: unknown;
  notes?: unknown;
  /** Allows dynamic extension slots without breaking type safety. */
  [key: string]: unknown;
}

export interface PolicyTurnDigest {
  round: number;
  turn: number;
  self_summary: Record<string, unknown>;
  opponent_summary: Record<string, unknown>;
  resource_summary: Record<string, unknown>;
  candidate_actions: PolicyCandidateAction[];
  opponent_declared_end?: boolean;
}

export interface TurnPlan {
  plannedActionSequence: string[];
  planKind: string;
  diceRequirements: Map<number, number>;
  protectedCharacterIds: number[];
  hasBurstWindow: boolean;
  hasReactionWindow: boolean;
}

export interface DiceReservation {
  reserved: Map<number, number>;
  estimatedRemainingActions: number;
  reservedForReason: string;
  tuningSuggested: boolean;
  tuningTarget: number | null;
}

export interface PolicyDecisionContext {
  observation?: ObservationV1 | null;
  macroPlanState?: RuntimeMacroPlanState | null;
  gamePlanState?: GamePlanRuntimeState | null;
  opponentModelState?: OpponentModelState | null;
  turnPlan?: TurnPlan | null;
  diceReservation?: DiceReservation | null;

  /** SPL: Phase-specific weight overrides for heuristic scoring */
  phaseWeightsOverride?: PhaseWeightsOverride | null;
  /** SPL: Dice budget that must be reserved for priority actions */
  diceBudget?: DiceReservationBudget[] | null;
  /** SPL: Threat-triggered bonus entries for defensive/priority actions */
  threatBonusMap?: Map<string, ThreatBonusEntry> | null;
  /** SPL: Banned action patterns — matching candidates are excluded from scoring */
  actionBanList?: ActionPattern[] | null;
  /** SPL: Primary action patterns for the current phase */
  primaryPatterns?: ActionPattern[] | null;
  /** SPL: Fixed bonus for matching a primary pattern */
  primaryMatchBonus?: number;
  /** SPL: Whether the candidate set has been pre-filtered by SPL */
  splPreFiltered?: boolean;

  /** MCTS: Provider for the current GameState (from PolicyPlayerIO) */
  stateProvider?: () => any;

  /** ── V2 Framework: Lethal chains found for the current state */
  lethalChains?: LethalChain[] | null;
  /** ── V2 Framework: Risk assessment for the current state */
  /** -- V5: Dice allocation result from the current state */
  diceAllocation?: DiceAllocation | null;
  riskAssessment?: RiskAssessment | null;
  /** ── V2 Framework: Replan actions triggered in the current state */
  replanActions?: ReplanAction[] | null;
}

export interface RankedPolicyCandidate {
  candidateId: string;
  actionCase: string;
  heuristicScore: number;
  learnedScore?: number;
  finalScore: number;
  reasons: string[];
  candidate: PolicyCandidateAction;
}

export interface CandidateScoreBreakdown {
  giMlScore: number
  guardrail: number
  qValueAdjustment: number
  valueAdjustment: number
  followupAdjustment: number
  macroPlanAdjustment: number
  searchAdjustment: number
  strategicValueAdjustment: number
  reactionChainAdjustment: number
  opponentAdjustment: number
  lethalChainBonus: number
  riskResponseBonus: number
  phaseAlignment: number
  diceFitness: number
  temporalOpportunityAdjustment: number
  tempoBonus: number
}

export interface PolicyDecision {
  selectedCandidateId: string | null;
  ranked: RankedPolicyCandidate[];
  macroPlanState?: RuntimeMacroPlanState | null;
  guidanceNotes?: string[];
}
