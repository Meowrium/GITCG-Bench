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
 * analysisV2 Zod schema — structured pre-game deck analysis output.
 *
 * See docs/PRE_GAME_DECK_ANALYSIS_BENCHMARK.md §2 for the full specification.
 *
 * Card and character IDs in evidence fields must come from the input deck
 * context (DeckContext.characterFullInfo[].id / DeckContext.cards[].id or
 * the .name string).  The evidence validator enforces this at scoring time.
 */

import { z } from "zod"

// ─── Primitive helpers ────────────────────────────────────────────────────

const Probability = z.number().min(0).max(1)
const NonEmptyString = z.string().min(1)

// Stable identifier from the input context: numeric definitionId as string,
// or the canonical name string.
const EvidenceId = NonEmptyString

// ─── Archetype weights ────────────────────────────────────────────────────

export const ARCHETYPE_LABELS = [
  "tempo",
  "midrange",
  "control",
  "combo",
  "ramp",
  "aggro",
  "attrition",
  "burn",
  "mill",
  "other",
] as const

export type ArchetypeLabel = (typeof ARCHETYPE_LABELS)[number]

export const ArchetypeWeightsSchema = z
  .record(z.enum(ARCHETYPE_LABELS), Probability)
  .refine(
    (entries: Record<string, number>) => {
      const sum = Object.values(entries).reduce((a: number, b: number) => a + b, 0)
      return sum <= 1.0 + 1e-6
    },
    { message: "archetypeWeights sum must not exceed 1.0" },
  )

// ─── Pace ──────────────────────────────────────────────────────────────────

export const PaceSchema = z.object({
  setupRounds: z.object({
    min: z.number().int().min(0),
    max: z.number().int().min(0),
  }),
  pressurePeakRounds: z.array(z.number().int().min(1)),
  lateGameReliance: Probability,
})

// ─── Win conditions ────────────────────────────────────────────────────────

export const WinConditionKindSchema = z.enum([
  "burst",
  "board_lock",
  "attrition",
  "engine",
  "other",
])

export const WinConditionSchema = z.object({
  id: NonEmptyString,
  kind: WinConditionKindSchema,
  description: NonEmptyString,
  requiredPieces: z.array(EvidenceId),
  evidence: z.array(EvidenceId).min(1),
  confidence: Probability,
})

// ─── Key pieces ───────────────────────────────────────────────────────────

export const KeyPieceRoleSchema = z.enum([
  "enabler",
  "payoff",
  "engine",
  "tutor",
  "protection",
  "finisher",
])

export const KeyPieceNecessitySchema = z.enum([
  "required",
  "replaceable",
  "optional",
])

export const KeyPieceSchema = z.object({
  id: EvidenceId,
  role: KeyPieceRoleSchema,
  necessity: KeyPieceNecessitySchema,
  evidence: z.array(EvidenceId).min(1),
  confidence: Probability,
})

// ─── Lines ─────────────────────────────────────────────────────────────────

export const LineKindSchema = z.enum([
  "combo",
  "pressure",
  "stabilize",
  "value",
])

export const LineStepSchema = z.object({
  actor: EvidenceId,
  effect: NonEmptyString,
  evidence: z.array(EvidenceId),
})

export const LineSchema = z.object({
  id: NonEmptyString,
  kind: LineKindSchema,
  steps: z.array(LineStepSchema).min(1),
  preconditions: z.array(NonEmptyString),
  payoff: NonEmptyString,
  fragility: z.array(NonEmptyString),
  confidence: Probability,
})

// ─── Resource plan ─────────────────────────────────────────────────────────

export const ResourcePrioritySchema = z.enum([
  "dice",
  "cards",
  "energy",
  "tempo",
  "board_slots",
])

export const ResourceBottleneckSchema = z.object({
  resource: ResourcePrioritySchema,
  reason: NonEmptyString,
  evidence: z.array(EvidenceId),
})

export const ResourcePlanSchema = z.object({
  priority: z.array(ResourcePrioritySchema),
  bottlenecks: z.array(ResourceBottleneckSchema),
})

// ─── Deck profile ──────────────────────────────────────────────────────────

export const DeckProfileSchema = z.object({
  archetypeWeights: ArchetypeWeightsSchema,
  primaryArchetypes: z.array(z.enum(ARCHETYPE_LABELS)),
  pace: PaceSchema,
  winConditions: z.array(WinConditionSchema),
  keyPieces: z.array(KeyPieceSchema),
  lines: z.array(LineSchema),
  resourcePlan: ResourcePlanSchema,
})

// ─── Matchup ───────────────────────────────────────────────────────────────

export const SeveritySchema = z.enum(["low", "medium", "high"])

export const OpponentThreatSchema = z.object({
  id: NonEmptyString,
  source: EvidenceId,
  window: z.object({
    minRound: z.number().int().min(1),
    maxRound: z.number().int().min(1),
  }),
  severity: SeveritySchema,
  counterplay: z.array(NonEmptyString),
  evidence: z.array(EvidenceId).min(1),
  confidence: Probability,
})

export const TargetPaceSchema = z.enum([
  "race",
  "stabilize",
  "deny_setup",
  "outvalue",
])

export const RelativePlanSchema = z.object({
  advantageAxes: z.array(
    z.enum(["tempo", "burst", "resource", "board", "consistency"]),
  ),
  targetPace: TargetPaceSchema,
  confidence: Probability,
})

export const MatchupSchema = z.object({
  opponentThreats: z.array(OpponentThreatSchema),
  relativePlan: RelativePlanSchema,
})

// ─── Abstentions ───────────────────────────────────────────────────────────

export const AbstentionSchema = z.object({
  field: NonEmptyString,
  reason: NonEmptyString,
})

// ─── AnalysisV2 (the full analysis block) ─────────────────────────────────

export const AnalysisV2Schema = z.object({
  deckProfile: DeckProfileSchema,
  matchup: MatchupSchema,
  abstentions: z.array(AbstentionSchema),
})

// ─── Input identity ────────────────────────────────────────────────────────

export const DeckIdentitySchema = z.object({
  code: NonEmptyString,
  version: NonEmptyString,
  contextHash: NonEmptyString,
})

export const InputIdentitySchema = z.object({
  myDeck: DeckIdentitySchema,
  opponentDeck: DeckIdentitySchema.optional(),
})

// ─── Top-level wrapper ─────────────────────────────────────────────────────

export const AnalysisOutputSchema = z.object({
  analysisSchemaVersion: z.literal("2.0"),
  inputIdentity: InputIdentitySchema,
  analysisV2: AnalysisV2Schema,
})

// ─── Inferred types ───────────────────────────────────────────────────────

export type AnalysisOutput = z.infer<typeof AnalysisOutputSchema>
export type AnalysisV2 = z.infer<typeof AnalysisV2Schema>
export type DeckProfile = z.infer<typeof DeckProfileSchema>
export type WinCondition = z.infer<typeof WinConditionSchema>
export type KeyPiece = z.infer<typeof KeyPieceSchema>
export type Line = z.infer<typeof LineSchema>
export type OpponentThreat = z.infer<typeof OpponentThreatSchema>
export type RelativePlan = z.infer<typeof RelativePlanSchema>
export type Abstention = z.infer<typeof AbstentionSchema>
export type DeckIdentity = z.infer<typeof DeckIdentitySchema>
export type InputIdentity = z.infer<typeof InputIdentitySchema>

// ─── Validation helpers ────────────────────────────────────────────────────

/**
 * Primary archetypes are those with weight >= 0.35 (see doc §2 constraints).
 */
export const PRIMARY_ARCHETYPE_THRESHOLD = 0.35

/**
 * Validate primaryArchetypes consistency: every entry must have weight >= 0.35,
 * and every archetype with weight >= 0.35 should be listed.
 * Returns a list of issues (empty if valid).
 */
export function validatePrimaryArchetypes(
  archetypeWeights: Record<string, number>,
  primaryArchetypes: string[],
): string[] {
  const issues: string[] = []
  const threshold = PRIMARY_ARCHETYPE_THRESHOLD

  for (const label of primaryArchetypes) {
    const w = archetypeWeights[label]
    if (w === undefined) {
      issues.push(`primaryArchetype "${label}" has no weight entry`)
    } else if (w < threshold) {
      issues.push(
        `"${label}" listed as primary but weight ${w} < ${threshold}`,
      )
    }
  }

  for (const [label, weight] of Object.entries(archetypeWeights)) {
    if (weight >= threshold && !primaryArchetypes.includes(label)) {
      issues.push(
        `"${label}" has weight ${weight} >= ${threshold} but is not in primaryArchetypes`,
      )
    }
  }

  return issues
}
