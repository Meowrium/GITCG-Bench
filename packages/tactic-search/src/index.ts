// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

// Layer 0
export { SimAdapter } from "./sim-adapter";

// Layer 1
export { BoundedSearcher } from "./bounded-searcher";

// Layer 2
export { StateEvaluator, DEFAULT_WEIGHTS } from "./state-evaluator";
export type { EvalWeights } from "./state-evaluator";

// Layer 3
export { ComboRegistry } from "./combo-registry";

// Layer 4
export {
  toRecommendations,
  toCandidatePolicies,
  toTurnPriorities,
  formatAnnotation,
} from "./mcp-output";
export type { CandidatePolicy, TurnPriority } from "./mcp-output";

// Types
export type {
  SimResult,
  ActionType,
  ActionDescription,
  StateDelta,
  DiceFeasibility,
  HandDependency,
  SearchConfig,
  SearchResult,
  ComboEntry,
  ComboPreconditions,
  ComboAction,
  ComboEvaluation,
  ComboRecommendation,
  ComboQuery,
} from "./types";
