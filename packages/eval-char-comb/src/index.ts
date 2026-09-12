// @gi-tcg/eval-char-comb — 角色组合评估与牌组预过滤
//
// plan-v2 的上游预过滤器：
//   角色池(133+) × 卡牌池 → 候选牌组(50-200) → plan-v2 模拟评估

export { CharacterProfileService } from "./CharacterProfileService.js";
export { CharacterProfileExtractor } from "./profiler/CharacterProfileExtractor.js";
export { DeckCandidateFilter } from "./DeckCandidateFilter.js";
export { parseAllCharacterSources } from "./profiler/SourceParser.js";
export { parseCardAffinities } from "./card-affinity/CardAffinityAnalyzer.js";

export {
  computeElementalCompatibility,
  computeReactionCoverage,
  computeCostCompatibility,
  computeTempoCompatibility,
  computeTripleBurstStagger,
  computePairCompatibility,
  computeDeckCompatibility,
} from "./compatibility/index.js";

export { estimateSkillPhaseValue } from "./profiler/SkillPhaseValueEstimator.js";

export type {
  // Phase A
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
  // Phase B
  ElementalCompatibility,
  CostCompatibility,
  TempoCompatibility,
  PairCompatibility,
  DeckCompatibilityScore,
  // Phase C
  CardAffinityType,
  CardCharacterAffinity,
  // Value types
  DamageTypeValue,
  DiceTypeValue,
  ReactionValue,
} from "./profiler/types.js";

export type {
  DeckCandidate,
  CardRecommendation,
} from "./DeckCandidateFilter.js";
