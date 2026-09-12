// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

export {
  DeckAnalyzer,
  decodeDeck,
  formatDeckForLLM,
  buildDeckAnalysisPrompt,
  buildMatchupAnalysisPrompt,
  mergeDeckAnalysis,
  mergeMatchupAnalysis,
  parseJsonAnalysisResult,
} from "./analyzer"
export type { AssetsManager } from "@gi-tcg/assets-manager"
export {
  createDeckContext,
  createMatchupContext,
  createRichDeckContext,
  buildLocalDeckAnalysis,
  buildLocalMatchupAnalysis,
} from "./heuristics"
export type {
  DeckContext,
  MatchupContext,
  RichDeckContext,
  DeckCharacterInfo,
  DeckCharacterFullInfo,
  CharacterSkillData,
  DeckCardInfo,
  ChainEdgeBrief,
  ChainBrief,
} from "./heuristics"
export { buildDeckPromptContext } from "./prompt-builder"
export {
  ACTION_CARD_FUNCTION_TAGS,
  ACTION_CARD_PACKAGES,
  FEATURE_VOCABULARY,
  ActionCardFeatureBlockSchema,
  ActionCardTempoProfileSchema,
  DeckDenseFeaturesSchema,
  DeckFeaturesV2Schema,
  DeckGraphEdgeSchema,
  DeckGraphFeaturesSchema,
  DeckGraphNodeSchema,
  DeckLabelsSchema,
  FeatureDiagnosticsSchema,
  LlmAuxiliaryLabelSchema,
  LlmAuxiliaryOutputSchema,
  MatchupDenseFeaturesSchema,
  MatchupFeaturesV2Schema,
  MatchupGraphEdgeSchema,
  MatchupGraphFeaturesSchema,
  MatchupGraphNodeSchema,
  MatchupLabelsSchema,
  SparseFeatureSchema,
  extractDeckFeaturesV2,
  extractMatchupFeaturesV2,
} from "./features"
export type {
  DeckAnalysis,
  MatchupAnalysis,
  DeckFeatureVector,
  MatchupFeatureVector,
} from "./types"
export { DeckAnalysisSchema, MatchupAnalysisSchema } from "./types"
export type {
  StateDependencyEdge,
  CostDiscount,
  EffectiveCost,
  DrawEstimate,
  ComboClockResult,
  ResourceCycle,
  ZonePressureReport,
  SkillEfficiency,
} from "./analysis"
export type {
  ActionCardFeatureBlock,
  ActionCardTempoProfile,
  DeckDenseFeatures,
  DeckFeaturesV2,
  DeckGraphEdge,
  DeckGraphEdgeType,
  DeckGraphFeatures,
  DeckGraphNode,
  DeckGraphNodeType,
  DeckLabels,
  FeatureDiagnostics,
  FeatureVersion,
  FeatureVocabulary,
  LlmAuxiliaryLabel,
  LlmAuxiliaryOutput,
  MatchupDenseFeatures,
  MatchupFeaturesV2,
  MatchupGraphEdge,
  MatchupGraphEdgeType,
  MatchupGraphFeatures,
  MatchupGraphNode,
  MatchupGraphNodeType,
  MatchupLabels,
  SparseFeature,
} from "./features"
export {
  detectTriggerChainEdges,
  buildTriggerChains,
  detectDeckCombos,
} from "./effect-extractor"

// Enhanced analysis exports (P0-P2)
export {
  detectStateDependencies,
  computeEffectiveCost,
  computeAllEffectiveCosts,
  findFreeCards,
  estimateDrawExpectation,
  estimateComboClock,
  detectResourceCycles,
  analyzeZonePressure,
  computeSkillEfficiency,
} from "./analysis"

export type {
  InternalEventName,
  TriggerKind,
  EffectKind,
  TargetSpecifier,
  DamageTypeSpecifier,
  TriggerScope,
  ChainProbability,
  ParsedTrigger,
  ParsedEffect,
  ParsedSkill,
  CardEffectData,
  EffectSignal,
  SignalKind,
  TriggerSlot,
  TriggerChainEdge,
  TriggerChain,
  TriggerChainStep,
  EffectExtractionResult,
} from "./effect-extractor"