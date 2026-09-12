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

import { z } from "zod"

const MetadataValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
])

const MetadataSchema = z.record(MetadataValueSchema)

export const SparseFeatureSchema = z.object({
  key: z.string().min(1),
  value: z.number(),
  source: z.enum(["rule", "llm", "hybrid"]).optional(),
})

export const FeatureDiagnosticsSchema = z.object({
  extractorVersion: z.string(),
  warnings: z.array(z.string()),
  assumptions: z.array(z.string()),
  coverage: z.object({
    characterCoverage: z.number().min(0).max(1),
    actionCardCoverage: z.number().min(0).max(1),
    graphCoverage: z.number().min(0).max(1),
    matchupCrossCoverage: z.number().min(0).max(1).optional(),
  }),
})

export const DeckGraphNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    "character",
    "action_card",
    "package",
    "reaction_route",
    "engine",
    "dependency",
    "plan_phase",
    "threat",
  ]),
  label: z.string().min(1),
  weight: z.number().optional(),
  metadata: MetadataSchema.optional(),
})

export const DeckGraphEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.enum([
    "includes",
    "enables",
    "requires",
    "amplifies",
    "converts_to",
    "stabilizes",
    "conflicts_with",
    "protects",
    "finishes",
  ]),
  weight: z.number(),
  metadata: MetadataSchema.optional(),
})

export const DeckGraphFeaturesSchema = z.object({
  nodes: z.array(DeckGraphNodeSchema),
  edges: z.array(DeckGraphEdgeSchema),
})

export const ActionCardTempoProfileSchema = z.object({
  lowCostStarters: z.number().min(0),
  diceFixers: z.number().min(0),
  burstAmplifiers: z.number().min(0),
  defensiveTools: z.number().min(0),
  longGameEngines: z.number().min(0),
})

export const ActionCardFeatureBlockSchema = z.object({
  presence: z.array(SparseFeatureSchema),
  counts: z.array(SparseFeatureSchema),
  functionTags: z.array(SparseFeatureSchema),
  packages: z.array(SparseFeatureSchema),
  dependencies: z.array(SparseFeatureSchema),
  thresholds: z.array(SparseFeatureSchema),
  tempoProfile: ActionCardTempoProfileSchema,
})

export const DeckDenseFeaturesSchema = z.object({
  characterCount: z.number().int().min(0),
  elementCounts: z.record(z.number().min(0)),
  nationCounts: z.record(z.number().min(0)),
  weaponCounts: z.record(z.number().min(0)),
  actionCardTypeCounts: z.record(z.number().min(0)),
  actionCardSubtypeCounts: z.record(z.number().min(0)),
  costCurve: z.object({
    cost0: z.number().min(0),
    cost1: z.number().min(0),
    cost2: z.number().min(0),
    cost3Plus: z.number().min(0),
    averageCost: z.number().min(0),
  }),
  tempoProfile: z.object({
    setupSpeed: z.number(),
    tempoPush: z.number(),
    longGameValue: z.number(),
    defensiveStability: z.number(),
    finisherDensity: z.number(),
  }),
  strategyProfile: z.object({
    reactionReliance: z.number(),
    supportReliance: z.number(),
    talentReliance: z.number(),
    equipmentReliance: z.number(),
    summonReliance: z.number(),
    dependencyRisk: z.number(),
  }),
})

export const DeckLabelsSchema = z.object({
  archetypes: z.array(z.string()),
  plans: z.array(z.string()),
  risks: z.array(z.string()),
  routes: z.array(z.string()),
  packages: z.array(z.string()),
})

export const LlmAuxiliaryLabelSchema = z.object({
  label: z.string(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
})

export const LlmAuxiliaryOutputSchema = z.object({
  archetypes: z.array(LlmAuxiliaryLabelSchema),
  plans: z.array(LlmAuxiliaryLabelSchema),
  risks: z.array(LlmAuxiliaryLabelSchema),
  matchupNarratives: z.array(LlmAuxiliaryLabelSchema).optional(),
  uncertaintyNotes: z.array(z.string()),
  missingContextNotes: z.array(z.string()),
})

export const DeckFeaturesV2Schema = z.object({
  deckCode: z.string().min(1),
  version: z.literal("v2"),
  dense: DeckDenseFeaturesSchema,
  sparse: z.array(SparseFeatureSchema),
  actionCards: ActionCardFeatureBlockSchema,
  graph: DeckGraphFeaturesSchema,
  labels: DeckLabelsSchema,
  diagnostics: FeatureDiagnosticsSchema,
  auxiliary: z
    .object({
      llm: LlmAuxiliaryOutputSchema.optional(),
    })
    .optional(),
})

export const MatchupGraphNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    "character",
    "action_card",
    "package",
    "reaction_route",
    "engine",
    "dependency",
    "plan_phase",
    "threat",
    "matchup_axis",
    "cross_feature",
  ]),
  label: z.string().min(1),
  side: z.enum(["A", "B", "cross"]).optional(),
  weight: z.number().optional(),
  metadata: MetadataSchema.optional(),
})

export const MatchupGraphEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.enum([
    "includes",
    "enables",
    "requires",
    "amplifies",
    "converts_to",
    "stabilizes",
    "conflicts_with",
    "protects",
    "finishes",
    "pressures",
    "punishes",
    "outraces",
    "denies",
    "mirrors",
    "invalidates",
    "checks",
    "is_soft_to",
  ]),
  weight: z.number(),
  metadata: MetadataSchema.optional(),
})

export const MatchupGraphFeaturesSchema = z.object({
  nodes: z.array(MatchupGraphNodeSchema),
  edges: z.array(MatchupGraphEdgeSchema),
})

export const MatchupDenseFeaturesSchema = z.object({
  setupSpeedDelta: z.number(),
  longGameValueDelta: z.number(),
  supportGreedDelta: z.number(),
  defensiveStabilityDelta: z.number(),
  finisherDensityDelta: z.number(),
  punishGreedySetupDelta: z.number(),
  antiSummonDelta: z.number(),
  antiSupportDelta: z.number(),
  routeConflictScore: z.number(),
  dependencyPunishScore: z.number(),
})

export const MatchupLabelsSchema = z.object({
  tempoAxes: z.array(z.string()),
  pressureAxes: z.array(z.string()),
  routeConflicts: z.array(z.string()),
  keyPackages: z.array(z.string()),
  risks: z.array(z.string()),
})

export const MatchupFeaturesV2Schema = z.object({
  deckA: z.string().min(1),
  deckB: z.string().min(1),
  version: z.literal("v2"),
  dense: MatchupDenseFeaturesSchema,
  sparse: z.array(SparseFeatureSchema),
  graph: MatchupGraphFeaturesSchema,
  labels: MatchupLabelsSchema,
  diagnostics: FeatureDiagnosticsSchema,
  auxiliary: z
    .object({
      llm: LlmAuxiliaryOutputSchema.optional(),
    })
    .optional(),
})
