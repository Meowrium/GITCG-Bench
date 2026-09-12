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

export type FeatureVersion = "v2"

export interface SparseFeature {
  key: string
  value: number
  source?: "rule" | "llm" | "hybrid"
}

export interface FeatureDiagnostics {
  extractorVersion: string
  warnings: string[]
  assumptions: string[]
  coverage: {
    characterCoverage: number
    actionCardCoverage: number
    graphCoverage: number
    matchupCrossCoverage?: number
  }
}

export type DeckGraphNodeType =
  | "character"
  | "action_card"
  | "package"
  | "reaction_route"
  | "engine"
  | "dependency"
  | "plan_phase"
  | "threat"

export type DeckGraphEdgeType =
  | "includes"
  | "enables"
  | "requires"
  | "amplifies"
  | "converts_to"
  | "stabilizes"
  | "conflicts_with"
  | "protects"
  | "finishes"

export interface DeckGraphNode {
  id: string
  type: DeckGraphNodeType
  label: string
  weight?: number
  metadata?: Record<string, string | number | boolean | string[]>
}

export interface DeckGraphEdge {
  from: string
  to: string
  type: DeckGraphEdgeType
  weight: number
  metadata?: Record<string, string | number | boolean | string[]>
}

export interface DeckGraphFeatures {
  nodes: DeckGraphNode[]
  edges: DeckGraphEdge[]
}

export interface ActionCardTempoProfile {
  lowCostStarters: number
  diceFixers: number
  burstAmplifiers: number
  defensiveTools: number
  longGameEngines: number
}

export interface ActionCardFeatureBlock {
  presence: SparseFeature[]
  counts: SparseFeature[]
  functionTags: SparseFeature[]
  packages: SparseFeature[]
  dependencies: SparseFeature[]
  thresholds: SparseFeature[]
  tempoProfile: ActionCardTempoProfile
}

export interface DeckDenseFeatures {
  characterCount: number
  elementCounts: Record<string, number>
  nationCounts: Record<string, number>
  weaponCounts: Record<string, number>
  actionCardTypeCounts: Record<string, number>
  actionCardSubtypeCounts: Record<string, number>
  costCurve: {
    cost0: number
    cost1: number
    cost2: number
    cost3Plus: number
    averageCost: number
  }
  tempoProfile: {
    setupSpeed: number
    tempoPush: number
    longGameValue: number
    defensiveStability: number
    finisherDensity: number
  }
  strategyProfile: {
    reactionReliance: number
    supportReliance: number
    talentReliance: number
    equipmentReliance: number
    summonReliance: number
    dependencyRisk: number
  }
}

export interface DeckLabels {
  archetypes: string[]
  plans: string[]
  risks: string[]
  routes: string[]
  packages: string[]
}

export interface LlmAuxiliaryLabel {
  label: string
  reason: string
  confidence: number
}

export interface LlmAuxiliaryOutput {
  archetypes: LlmAuxiliaryLabel[]
  plans: LlmAuxiliaryLabel[]
  risks: LlmAuxiliaryLabel[]
  matchupNarratives?: LlmAuxiliaryLabel[]
  uncertaintyNotes: string[]
  missingContextNotes: string[]
}

export interface DeckFeaturesV2 {
  deckCode: string
  version: FeatureVersion
  dense: DeckDenseFeatures
  sparse: SparseFeature[]
  actionCards: ActionCardFeatureBlock
  graph: DeckGraphFeatures
  labels: DeckLabels
  diagnostics: FeatureDiagnostics
  auxiliary?: {
    llm?: LlmAuxiliaryOutput
  }
}

export type MatchupGraphNodeType = DeckGraphNodeType | "matchup_axis" | "cross_feature"

export type MatchupGraphEdgeType =
  | DeckGraphEdgeType
  | "pressures"
  | "punishes"
  | "outraces"
  | "denies"
  | "mirrors"
  | "invalidates"
  | "checks"
  | "is_soft_to"

export interface MatchupGraphNode {
  id: string
  type: MatchupGraphNodeType
  label: string
  side?: "A" | "B" | "cross"
  weight?: number
  metadata?: Record<string, string | number | boolean | string[]>
}

export interface MatchupGraphEdge {
  from: string
  to: string
  type: MatchupGraphEdgeType
  weight: number
  metadata?: Record<string, string | number | boolean | string[]>
}

export interface MatchupGraphFeatures {
  nodes: MatchupGraphNode[]
  edges: MatchupGraphEdge[]
}

export interface MatchupDenseFeatures {
  setupSpeedDelta: number
  longGameValueDelta: number
  supportGreedDelta: number
  defensiveStabilityDelta: number
  finisherDensityDelta: number
  punishGreedySetupDelta: number
  antiSummonDelta: number
  antiSupportDelta: number
  routeConflictScore: number
  dependencyPunishScore: number
}

export interface MatchupLabels {
  tempoAxes: string[]
  pressureAxes: string[]
  routeConflicts: string[]
  keyPackages: string[]
  risks: string[]
}

export interface MatchupFeaturesV2 {
  deckA: string
  deckB: string
  version: FeatureVersion
  dense: MatchupDenseFeatures
  sparse: SparseFeature[]
  graph: MatchupGraphFeatures
  labels: MatchupLabels
  diagnostics: FeatureDiagnostics
  auxiliary?: {
    llm?: LlmAuxiliaryOutput
  }
}

export interface FeatureVocabulary {
  version: FeatureVersion
  namespaces: string[]
  actionCardFunctionTags: string[]
  actionCardPackages: string[]
  deckGraphNodeTypes: DeckGraphNodeType[]
  deckGraphEdgeTypes: DeckGraphEdgeType[]
  matchupGraphNodeTypes: MatchupGraphNodeType[]
  matchupGraphEdgeTypes: MatchupGraphEdgeType[]
}
