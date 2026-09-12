export { FragmentResolver } from "./FragmentResolver";
export { CandidateEnricher } from "./CandidateEnricher";
export type { EnrichmentContext } from "./CandidateEnricher";
export { RiskEvaluator } from "./RiskEvaluator";
export type { RiskBreakdown, RiskContext, CharacterSummary } from "./RiskEvaluator";
export { ResourceWeightCalculator } from "./ResourceWeightCalculator";
export type { ResourceContext, ResourceWeights, ResourcePenaltyBreakdown } from "./ResourceWeightCalculator";
export { FuturePotentialEvaluator } from "./FuturePotentialEvaluator";
export type { FuturePotentialContext, FuturePotentialBreakdown, CharacterEnergyInfo } from "./FuturePotentialEvaluator";
export { StrategyMatcher } from "./StrategyMatcher";
export type { MatchTier, MatchResult, StrategyMatchBreakdown } from "./StrategyMatcher";
export {
  ALL_STANDARD_LABELS,
  ACTION_CATEGORY_LABELS,
  STRATEGY_INTENT_LABELS,
  SYNONYM_MAP,
} from "./label-taxonomy";
export type { ActionCategoryLabel, StrategyIntentLabel } from "./label-taxonomy";
export {
  safeNumber,
  normalizeLabel,
  containsLabel,
  totalCostFromCandidate,
} from "./scoring-utils";
export type {
  ActiveCombatWindowState,
  CombatWindowSelection,
  TurnDigestV1,
  DecisionFragmentV1,
  ExecutionFeedbackV1,
  FragmentedDecisionState,
  ResolverScore,
  ResolverScoredCandidate,
  ResolverDecision,
  OpeningPlanLock,
  ResolverRuntimeContext,
} from "./types";
