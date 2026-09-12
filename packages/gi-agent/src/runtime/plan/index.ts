// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

export type {
  ActionPattern,
  AnyCondition,
  AuraType,
  CardClass,
  Condition,
  DeckMeta,
  DiceAllocation,
  DiceBucket,
  DiceReservationBudget,
  PhaseTransition,
  PhaseWeightsOverride,
  PlanPhase,
  ReplanAction,
  ReplanTriggerDef,
  SPLContext,
  ThreatBonusEntry,
  ThreatRule,
  V2Condition,
  V2PlanPhase,
} from "./types.js"

export { StrategicPlanStateMachine } from "./state-machine.js"
export type { PlanStateMachineState, PlanUpdateInput } from "./state-machine.js"

export { classifyDeck, compileDeckAnalysisToPlan, createStaticPlanForDeck } from "./compiler.js"

export { matchPattern, matchAnyPattern, findMatchingPattern } from "./pattern-matcher.js"

export {
  allocateDiceToBuckets,
  buildDiceBucketsFromActions,
  checkDiceBudgetViolations,
  computeDiceBudgetPlan,
  computePlanFitness,
} from "./dice-budget.js"
export type { BudgetCheckResult, BudgetViolationDetail } from "./dice-budget.js"

export {
  applyPhaseWeightOverrides,
  buildSPLContextFields,
  computeDiceBudgetPenalty,
  computePrimaryMatchBonus,
  computeThreatBonus,
  filterBannedActions,
} from "./scorer-adapter.js"
export type { SPLPolicyContextFields } from "./scorer-adapter.js"

export { computeMatchupDelta } from "./matchup-delta.js"
export type { MatchupDelta } from "./matchup-delta.js"

export {
  deckFingerprintForPlan,
  loadPlanFile,
  loadPlanMeta,
  loadPlanWithMatchupAwareness,
} from "./plan-loader.js"
