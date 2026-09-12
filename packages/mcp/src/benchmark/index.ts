// Copyright (C) 2025 Guyutongxue
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

/**
 * Pre-Game Deck Analysis Benchmark
 *
 * See docs/PRE_GAME_DECK_ANALYSIS_BENCHMARK.md for the full specification.
 *
 * Exports:
 *   - analysis-v2-schema: Zod schema for analysisV2 output
 *   - evidence-validator: ID/evidence validation
 *   - variant-generator: minimal-change deck variants
 *   - scorer: 100-point scoring system
 *   - bootstrap: grouped-bootstrap CI reporter
 */

// Schema
export {
  AnalysisOutputSchema,
  AnalysisV2Schema,
  DeckProfileSchema,
  MatchupSchema,
  ArchetypeWeightsSchema,
  PaceSchema,
  WinConditionSchema,
  KeyPieceSchema,
  LineSchema,
  ResourcePlanSchema,
  OpponentThreatSchema,
  RelativePlanSchema,
  AbstentionSchema,
  InputIdentitySchema,
  DeckIdentitySchema,
  ARCHETYPE_LABELS,
  PRIMARY_ARCHETYPE_THRESHOLD,
  validatePrimaryArchetypes,
  type AnalysisOutput,
  type AnalysisV2,
  type DeckProfile,
  type WinCondition,
  type KeyPiece,
  type Line,
  type OpponentThreat,
  type RelativePlan,
  type Abstention,
  type DeckIdentity,
  type InputIdentity,
  type ArchetypeLabel,
} from "./analysis-v2-schema"

// Evidence validator
export {
  extractValidIds,
  buildValidIdSet,
  validateEvidence,
  validateSchema,
  type ValidIdSet,
  type EvidenceIssue,
  type EvidenceValidationResult,
  type SchemaValidationResult,
} from "./evidence-validator"

// Variant generator
export {
  generateVariants,
  makeLineageId,
  type VariantKind,
  type DeckVariant,
  type VariantResult,
} from "./variant-generator"

// Scorer
export {
  scoreAnalysis,
  macroAverage,
  type ScorerInput,
  type ScoreResult,
  type Subscore,
  type GoldAnalysis,
} from "./scorer"

// Bootstrap
export {
  runBootstrap,
  compareModels,
  formatCI,
  formatComparison,
  type BootstrapConfig,
  type BootstrapCI,
  type BootstrapReport,
  type ComparisonReport,
} from "./bootstrap"
