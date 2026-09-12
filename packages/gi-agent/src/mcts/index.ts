// Copyright (C) 2024-2025 Guyutongxue
//
// MCTS module barrel export.

export { diceVectorFromArray, diceCanAfford, diceAfterPaying, diceTotal, DICE_ZERO } from "./dice-vector.js"
export type { DiceVector } from "./dice-vector.js"

export {
  takeActionPhaseSnapshot,
  simulateAction,
  buildMctsAction,
  isOpponentAlive,
  selfActiveHp,
  oppActiveHp,
} from "./state-snapshot.js"
export type {
  ActionPhaseSnapshot,
  CharSnapshot,
  EntitySnapshot,
  MctsAction,
  MctsActionType,
  EngineActionInfo,
} from "./state-snapshot.js"

export { MctsEngine } from "./mcts.js"
export type { MctsConfig, PolicyPriorFn, ValueFn } from "./mcts.js"

export {
  createPolicyPrior,
  createValueFn,
  createActionGenerator,
  createRankerScoreFn,
  heuristicValueFn,
} from "./mcts-policy.js"
export type { MctsPolicyConfig } from "./mcts-policy.js"

export { buildSnapshotValueFeatures, createGbdtValueFn } from "./value-features.js"

// V31 F6 / V30 §6 — Engine-exact ISMCTS.
export {
  legalActions,
  runEngineActions,
  engineExactStep,
  type DecideActionFn,
  type EngineStepResult,
} from "./engine-step.js"
export {
  randomizeUnknowns,
  sampleDeterminizations,
  makeLcg,
  type Rng,
  type RandomizeOptions,
} from "./determinization.js"
export {
  ismctsSearch,
  actionSignature,
  DEFAULT_ISMCTS_CONFIG,
  type IsmctsConfig,
  type IsmctsResult,
  type LeafEvaluator,
  type ActionPriorFn,
} from "./ismcts.js"
export {
  classifyAction,
  groupActions,
  progressiveWidth,
  type ActionGroupKey,
} from "./action-grouping.js"
export {
  createNeuralLeafEvaluator,
  createNeuralLeafEvaluatorWithActions,
  createNeuralPrior,
  createSameEvaluatorOpponent,
  observationFromState,
} from "./neural-leaf.js"
