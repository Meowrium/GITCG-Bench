// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type { GameState, DeckConfig } from "@gi-tcg/core";
import type {
  ExposedMutation,
  DiceType,
  Reaction,
} from "@gi-tcg/typings";

/**
 * Layer 0: SimAdapter types
 */

export interface SimResult {
  /** New state after the action */
  readonly newState: GameState;
  /** Exposed mutations that occurred */
  readonly exposedMutations: readonly ExposedMutation[];
  /** Whether preview stopped due to IO interruption */
  readonly stopped: boolean;
}

export type ActionType =
  | "useSkill"
  | "playCard"
  | "switchActive"
  | "elementalTuning"
  | "declareEnd";

/** Serializable action description for replay and combo storage */
export interface ActionDescription {
  readonly type: ActionType;
  /** definition ID of skill/card/character depending on type */
  readonly definitionId: number;
  /** Target definition IDs if applicable */
  readonly targetDefinitionIds?: readonly number[];
  /** Whether this is a fast action */
  readonly isFast: boolean;
  /** For elementalTuning, the card definition ID to convert */
  readonly tuningCardDefinitionId?: number;
}

/**
 * Layer 2: StateEvaluator types
 */

export interface StateDelta {
  // ── Damage dimension ──
  damageDealt: number;
  reactions: Reaction[];
  defeatedCount: number;

  // ── Resource dimension ──
  diceSpent: number;
  diceGained: number;
  cardsDrawn: number;
  energyDelta: number;
  entitiesCreated: number;
  entitiesRemoved: number;

  // ── Tempo dimension ──
  turnsConsumed: number;
  opponentWindowsGiven: number;

  // ── Position dimension ──
  myActiveChanged: boolean;
  oppActiveForced: boolean;

  // ── Defense dimension ──
  healingDone: number;
  myHealthLost: number;

  // ── Feasibility dimension ──
  diceFeasibility: number;
  handDependencyTurns: number;
}

export interface DiceFeasibility {
  sampleCount: number;
  feasibleCount: number;
  feasibilityRate: number;
  avgDiceDeficit: number;
}

export interface HandDependency {
  requiredCardDefIds: readonly number[];
  inHandNow: readonly number[];
  notInHand: readonly number[];
  remainingInPile: number;
  expectedTurnToComplete: number;
  isGuaranteedThisTurn: boolean;
}

/**
 * Layer 1: BoundedSearcher types
 */

export interface SearchConfig {
  /** Max forward steps, recommended 4~6 */
  maxDepth: number;
  /** Candidates kept per level, recommended 8~15 */
  beamWidth: number;
  /** Perspective player */
  perspective: 0 | 1;
  /** Enable minimax response after combat actions */
  enableMinimax: boolean;
  /** Opponent response search depth, recommended 1~2 */
  minimaxDepth: number;
}

export interface SearchResult {
  /** Action sequence as serializable descriptions */
  path: ActionDescription[];
  /** Final state after executing the path */
  stateAfter: GameState;
  /** Composite score */
  score: number;
  /** Delta vectors for each step */
  deltas: StateDelta[];
  /** Resource feasibility rating (current turn = 1.0) */
  feasibility: number;
}

/**
 * Layer 3: ComboRegistry types
 */

export interface ComboEntry {
  id: string;

  deckContext: {
    characters: readonly number[];
    requiredCards: readonly number[];
  };

  preconditions: ComboPreconditions;

  actionSequence: ComboAction[];

  evaluation: ComboEvaluation;

  discoveredBy: "beam-search" | "self-play" | "differential";
  gameVersion: string;
  sampleCount: number;
  avgWinrateContribution: number;
}

export interface ComboPreconditions {
  phase: "early" | "mid" | "late";
  myActive?: {
    definitionId: number;
    minEnergy?: number;
    hasStatus?: readonly number[];
  };
  myStandby?: {
    definitionId: number;
  }[];
  opponentActive?: {
    maxHealth?: number;
  };
  minDice?: number;
  requiredHandCards?: readonly number[];
}

export interface ComboAction {
  step: number;
  type: ActionType;
  definitionId: number;
  isFast: boolean;
  annotation?: string;
}

export interface ComboEvaluation {
  totalScore: number;
  delta: StateDelta;
  scoreBreakdown: Record<string, number>;
  riskFactors: {
    opponentResponseWindows: number;
    comboBreakProbability: number;
    resourceOvercommit: boolean;
  };
}

/**
 * Layer 4: MCP output types
 */

export interface ComboRecommendation {
  combo_id: string;
  priority: number;

  preconditions: string[];
  action_sequence: {
    step: number;
    tool: "choose_action" | "choose_active" | "elemental_tuning";
    args: {
      definition_id: number;
      skill_type?: "normal" | "elemental" | "burst" | "technique";
      target_definition_id?: number;
    };
    is_fast: boolean;
  }[];

  evaluation: {
    total_score: number;
    damage_dealt: number;
    dice_efficiency: number;
    turns_consumed: number;
    dice_feasibility: number;
    hand_dependency_turns: number;
    risk_factors: {
      opponent_response_windows: number;
      combo_break_probability: number;
      resource_overcommit: boolean;
    };
  };

  annotation?: string;
}

export interface ComboQuery {
  state: GameState;
  who: 0 | 1;
  topK: number;
  minScore?: number;
  mustIncludeCards?: readonly number[];
}
