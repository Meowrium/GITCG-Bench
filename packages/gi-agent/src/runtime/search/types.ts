// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type { GameState } from "@gi-tcg/core";
import type {
  ExposedMutation,
  Reaction,
} from "@gi-tcg/typings";
import type { ActionInfoWithModification } from "../adapters/internal-types.js";

export interface SimResult {
  readonly newState: GameState;
  readonly exposedMutations: readonly ExposedMutation[];
  readonly stopped: boolean;
}

export type ActionType =
  | "useSkill"
  | "playCard"
  | "switchActive"
  | "elementalTuning"
  | "declareEnd";

export interface ActionDescription {
  readonly type: ActionType;
  readonly definitionId: number;
  readonly targetDefinitionIds?: readonly number[];
  readonly isFast: boolean;
  readonly tuningCardDefinitionId?: number;
}

export interface StateDelta {
  damageDealt: number;
  reactions: Reaction[];
  defeatedCount: number;
  diceSpent: number;
  diceGained: number;
  cardsDrawn: number;
  energyDelta: number;
  entitiesCreated: number;
  entitiesRemoved: number;
  turnsConsumed: number;
  opponentWindowsGiven: number;
  myActiveChanged: boolean;
  oppActiveForced: boolean;
  healingDone: number;
  myHealthLost: number;
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

export interface SearchConfig {
  maxDepth: number;
  beamWidth: number;
  perspective: 0 | 1;
  enableMinimax: boolean;
  minimaxDepth: number;
  maxFastActionDepth?: number;
  expansionPolicy?: "uniform" | "policy_guided";
  expansionTopK?: number;
  feasibilityFloor?: number;
  valueFunction?: (state: GameState) => number;
  /** Simulate opponent actions for this many steps (default 2). Enables cross-round search. */
  maxOpponentDepth?: number;
  /** Continue search across round boundaries to find fast-action followups */
  crossRoundSearch?: boolean;
  /**
   * Optional ML-based scorer for action expansion ordering.
   * Receives the action and its index within the legal action list.
   * When provided, replaces the built-in heuristic scorer.
   */
  expansionScorer?: (action: ActionInfoWithModification, actionIdx: number) => number;
}

export interface SearchResult {
  path: ActionDescription[];
  stateAfter: GameState;
  score: number;
  deltas: StateDelta[];
  feasibility: number;
}
