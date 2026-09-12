/**
 * @gi-tcg/agent — Multi-agent system for Genius Invokation TCG.
 *
 * Phase 0: Scoring audit & calibration
 * Phase 1: BattleAgent (LangGraph.js)
 * Phase 2: DataLake + KnowledgeBase
 * Phase 3: R&D Agent iteration loop
 */

// ── Phase 0: Scoring ──
export { FeatureExtractor, type ScoringFeatureVector, type LabeledSample } from "./learning/scoring/feature-extractor.js";
export { LogisticCalibrator, type CalibratedWeights, type TrainOptions } from "./learning/scoring/logistic-reg.js";
export { ScoringAuditor, type AuditReport, type AuditFinding } from "./agents/scoring-auditor.js";

// ── Phase 1: Battle ──
export { buildBattleGraph, type BattleGraphOptions, type BattleGraphCompiled } from "./graphs/battle-graph.js";
// battle-agent.ts is a CLI entry point, not a library export

// ── Phase 2: Data ──
export { DataLake, type SampleRecord } from "./db/data-lake.js";
export { ReplayExtractor, type ExtractionResult } from "./db/extractor.js";

// ── Phase 3: Sandbox ──
export { SandboxRunner, type RunConfig, type BatchResult, type GameResult } from "./sandbox/runner.js";
export {
  SandboxRunner as BenchmarkSandboxRunner,
  type RunConfig as BenchmarkRunConfig,
  type BatchResult as BenchmarkBatchResult,
  type GameResult as BenchmarkGameResult,
} from "./evaluation/benchmark/sandbox-runner.js";
export {
  runBenchmarkSuite,
  type BenchmarkSide,
  type BenchmarkMatchup,
  type BenchmarkSuiteConfig,
  type BenchmarkMatchupResult,
  type BenchmarkSuiteResult,
} from "./evaluation/benchmark/benchmark-suite.js";
export {
  summarizeBenchmark,
  compareBenchmarks,
  formatBenchmarkComparisonMarkdown,
  type BenchmarkSummary,
  type BenchmarkComparison,
  type BenchmarkComparisonRow,
} from "./evaluation/benchmark/benchmark-report.js";
export {
  loadBenchmarkCliConfig,
  buildBenchmarkMatchups,
  createBenchmarkSide,
  createPolicyFromConfig,
  createBaselineSide,
  createEvaluatorSide,
  type BenchmarkCliConfig,
  type BenchmarkCliMatchup,
  type BenchmarkPolicyConfig,
  type LoadedBenchmarkCliConfig,
} from "./evaluation/benchmark/cli-config.js";

// ── Runtime Search Substrate ──
export { SimAdapter } from "./runtime/adapters/sim-adapter.js";
export type { ActionInfoWithModification } from "./runtime/adapters/internal-types.js";
export { BoundedSearcher, actionToDescription } from "./runtime/search/bounded-searcher.js";
export {
  PolicyPlayerIO,
  chooseSearchGuidedActionIndex,
  type PolicyPlayerIOOptions,
  type PolicyPlayerSearchOptions,
  type PolicyPlayerGameContext,
} from "./runtime/io/policy-player-io.js";
// ── One-Shot GamePlan（赛前决策树 benchmark；docs/plans/2026-08-21-one-shot-gameplan-benchmark.md）──
export * from "./runtime/plan-oneshot/index.js";
export { BaselinePolicy, type BaselinePolicyOptions } from "./runtime/policy/baseline-policy.js";
export { EvaluatorPolicy, type EvaluatorPolicyOptions } from "./runtime/policy/evaluator-policy.js";
export { GiMlPolicy, type GiMlPolicyOptions } from "./runtime/policy/gi-ml-policy.js";
export {
  advanceRuntimeMacroPlanState,
  resolveRuntimeMacroPlanState,
  scoreCandidateAgainstMacroPlan,
} from "./runtime/policy/macro-plan.js";
export { buildCombatWindowPlanSearchGuidance } from "./runtime/policy/plan-search.js";
export { estimateStrategicValueAdjustment } from "./runtime/policy/strategic-value.js";
export type {
  DeckPriorFeatureVector,
  PolicyDeckPriorContext,
  PolicyPriorMode,
} from "./runtime/policy/prior-types.js";
export type {
  PolicyCandidateAction,
  PolicyTurnDigest,
  RankedPolicyCandidate,
  PolicyDecision,
  RuntimeMacroPlan,
  RuntimeMacroPlanState,
} from "./runtime/policy/types.js";
export {
  DeltaExtractor,
} from "./runtime/eval-baselines/delta-extractor.js";
export {
  FeasibilityEstimator,
} from "./runtime/eval-baselines/feasibility-estimator.js";
export {
  HeuristicScorer,
} from "./runtime/eval-baselines/heuristic-scorer.js";
export type {
  EvalWeights as HeuristicEvalWeights,
  ScoreContext as HeuristicScoreContext,
} from "./runtime/eval-baselines/heuristic-scorer.js";
export {
  StateEvaluator,
  DEFAULT_WEIGHTS,
  type EvalWeights,
  type ScoreContext,
} from "./runtime/eval-baselines/state-evaluator.js";
export type {
  SimResult,
  ActionType,
  ActionDescription,
  StateDelta,
  DiceFeasibility,
  HandDependency,
  SearchConfig,
  SearchResult,
} from "./runtime/search/types.js";

// ── Knowledge / Priors Substrate ──
export type {
  CharacterOutputProfile,
  SkillProfile,
  SkillPhaseValue,
  SkillTrend,
  SkillCost,
  SkillOutput,
  SummonProfile,
  StatusProfile,
  AdditionalDamage,
  RhythmProfile,
  ResourceProfile,
  ComplexityProfile,
  CardAffinityType,
  CardCharacterAffinity,
  DamageTypeValue,
  DiceTypeValue,
  ReactionValue,
} from "./knowledge/character-profiles/types.js";
export { estimateSkillPhaseValue } from "./knowledge/character-profiles/skill-phase-value-estimator.js";
export type { PhaseEstimationContext } from "./knowledge/character-profiles/skill-phase-value-estimator.js";
export {
  parseAllCharacterSources,
  parseSkillDamageFromSource,
  parseComplexityFromSource,
} from "./knowledge/character-profiles/source-parser.js";
export type {
  SourceDamageInfo,
  SourceComplexityInfo,
} from "./knowledge/character-profiles/source-parser.js";
export { CharacterProfileExtractor } from "./knowledge/character-profiles/character-profile-extractor.js";
export { parseCardAffinities } from "./knowledge/deck-priors/card-affinity-analyzer.js";

// ── Learning Wrappers ──
export {
  DataLake as LearningDataLake,
  type SampleRecord as LearningSampleRecord,
} from "./db/data-lake.js";
export {
  FeatureExtractor as ActionFeatureExtractor,
  type ScoringFeatureVector as ActionScoringFeatureVector,
  type LabeledSample as ActionLabeledSample,
} from "./learning/scoring/feature-extractor.js";
export {
  DeckPriorProvider,
} from "./learning/features/deck-prior-provider.js";
export {
  flattenDeckMatchupPriors,
  scoreDeckPriorFeatures,
} from "./learning/features/deck-prior-flattener.js";
export {
  LogisticCalibrator as LearningLogisticCalibrator,
  type CalibratedWeights as LearningCalibratedWeights,
  type TrainOptions as LearningTrainOptions,
} from "./learning/scoring/logistic-reg.js";
export {
  trainEvaluatorFromDataLake,
  type TrainEvaluatorConfig,
  type TrainEvaluatorResult,
} from "./learning/training/train-evaluator.js";
export {
  SelfPlayCollector,
  type SelfPlaySide,
  type SelfPlayMatchup,
  type SelfPlayCollectorConfig,
  type SelfPlayMatchupCollectionResult,
  type SelfPlayCollectionResult,
} from "./learning/self-play/self-play-collector.js";
export {
  buildSelfPlayTopupPlan,
  type SelfPlayTopupStrategy,
  type SelfPlayTopupPlan,
  type SelfPlayTopupMatchupPlan,
} from "./learning/self-play/self-play-topup.js";
export {
  CombatWindowExtractor,
} from "./learning/combat-windows/window-extractor.js"
export {
  CombatWindowPostAnalyzer,
  type CombatWindowPostAnalyzerOptions,
} from "./learning/combat-windows/post-analysis.js"
export {
  TreeLake,
} from "./learning/combat-windows/tree-lake.js"
export {
  CombatWindowTreeValidator,
} from "./learning/combat-windows/tree-validator.js"
export {
  ReplayWindowAligner,
  buildCanonicalFingerprintFromReplayPoint,
  canonicalFingerprintKey,
  scoreWindowToReplayPoint,
  normalizeReplayFilePath,
  replayFileBaseName,
} from "./learning/combat-windows/replay-alignment.js"
export {
  BranchEvalImporter,
  type BranchEvalReport,
  type BranchEvalPoint,
} from "./learning/combat-windows/branch-eval-import.js"
export {
  exportCombatWindowLibrary,
  type CombatWindowLibrary,
  type CombatWindowLibraryEntry,
} from "./learning/combat-windows/export-library.js"
export {
  buildLibraryQueryFromWindow,
  buildLibraryQueryFromRuntimeDigest,
  buildLibraryQueryFromPolicyDigest,
  buildLibraryQueryFromCanonicalFingerprint,
  selectCombatWindowLibrary,
  type CombatWindowLibraryQuery,
  type CombatWindowLibraryQueryOptions,
  type RankedCombatWindowLibraryEntry,
  type CombatWindowLibrarySelection,
  type CombatWindowLibrarySelectorOptions,
} from "./learning/combat-windows/library-selector.js"
export {
  findRuntimeCharacterSummary,
  normalizeRuntimeTags,
  buildRuntimeCharacterDefinitionMap,
  resolveRuntimeActiveDefinitionIds,
  deriveDeckFingerprintsFromRuntimeDigest,
  collectRuntimeCandidateDefinitionIds,
} from "./learning/combat-windows/runtime-digest-utils.js"
export {
  evaluateCombatWindowLibrary,
  evaluateCombatWindowLibraryMode,
  type CombatWindowLibraryEvaluationQueryMode,
  type CombatWindowLibraryEvaluationQueryRow,
  type CombatWindowLibraryEvaluationMatchupSummary,
  type CombatWindowLibraryEvaluationSummary,
  type CombatWindowLibraryEvaluationReport,
  type CombatWindowLibraryEvaluationOptions,
} from "./learning/combat-windows/library-evaluator.js"
export {
  evaluateCombatWindowLibraryWorkload,
  type CombatWindowLibraryWorkloadQueryRow,
  type CombatWindowLibraryWorkloadDeckPairSummary,
  type CombatWindowLibraryWorkloadTopMatchupSummary,
  type CombatWindowLibraryWorkloadSummary,
  type CombatWindowLibraryWorkloadEvaluationOptions,
} from "./learning/combat-windows/library-workload-evaluator.js"
export type {
  CanonicalCombatWindowFingerprint,
  ReplayAlignmentSummary,
  BranchEvalSummary,
  RuntimePlanArtifact,
  RuntimeCharacterSummary,
  RuntimeCandidateAction,
  RuntimeDigestArtifact,
  RuntimeFragmentArtifact,
  RuntimeFeedbackArtifact,
  RuntimeWindowStep,
  CombatWindowFingerprint,
  CandidateCombatWindow,
  CombatWindowExtractionConfig,
  CombatWindowExtractionResult,
  CombatWindowNodeKind,
  CombatWindowPlanTransition,
  CombatWindowPlanNode,
  CombatWindowPlan,
  PostAnalysisBranchClaim,
  CombatWindowAnalysisRecord,
  TreeStatus,
  TreeRecord,
  TreeValidationSummary,
  TreeValidationRun,
  TreeUsageStat,
} from "./learning/combat-windows/types.js"
export * from "./learning/rl/index.js"
