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

import type {
  MlCandidateAction,
  MlDecisionPoint,
  SlotValue,
} from "../contracts/index.js"
import { readJsonFile } from "../io/index.js"
import type { RuntimeConceptState, RuntimeConceptValue } from "./types.js"

export interface LinearConceptModelConcept {
  concept_id: string
  scope: "state" | "state_action" | "aggregate_candidate"
  bias: number
  feature_weights: Record<string, number>
  positive_rate?: number | null
  training_example_count?: number
}

export interface LinearConceptModelArtifact {
  artifact_type: "concept_model.linear.v1"
  artifact_version: string
  created_at: string
  bank_version?: string | null
  compatibility?: SlotValue
  concepts: LinearConceptModelConcept[]
  metadata?: SlotValue
}

export async function readLinearConceptModelArtifact(
  path: string,
): Promise<LinearConceptModelArtifact> {
  return readJsonFile<LinearConceptModelArtifact>(path)
}

export class LinearConceptModelPredictor {
  readonly artifact: LinearConceptModelArtifact

  constructor(artifact: LinearConceptModelArtifact) {
    this.artifact = artifact
  }

  predict(
    query: MlDecisionPoint,
    candidates: readonly MlCandidateAction[],
  ): RuntimeConceptState {
    const values = this.artifact.concepts
      .map((concept) => predictConceptValue(concept, query, candidates))
      .filter((value): value is RuntimeConceptValue => value != null)
      .sort((left, right) => left.concept_id.localeCompare(right.concept_id))

    return {
      query_id: query.query_id,
      values,
      summary_slots: {
        concept_model_artifact_version: this.artifact.artifact_version,
        predicted_concept_count: values.length,
      },
    }
  }
}

function predictConceptValue(
  concept: LinearConceptModelConcept,
  query: MlDecisionPoint,
  candidates: readonly MlCandidateAction[],
): RuntimeConceptValue | null {
  if (concept.scope === "aggregate_candidate") {
    return predictAggregateCandidateConcept(concept, query, candidates)
  }

  if (concept.scope === "state_action") {
    const scored = candidates
      .map((candidate) => ({
        candidate,
        probability: predictProbability(
          concept,
          extractFeatures(query, candidate),
        ),
      }))
      .sort((left, right) => right.probability - left.probability)
    const top = scored[0]
    if (!top) {
      return null
    }
    return {
      concept_id: concept.concept_id,
      value_slot: {
        probability: top.probability,
        predicted: top.probability >= 0.5,
        scope: concept.scope,
        top_candidate_id: top.candidate.candidate_id,
      },
      confidence: Math.abs(top.probability - 0.5) * 2,
      evidence_refs: [top.candidate.candidate_id],
    }
  }

  const probability = predictProbability(concept, extractFeatures(query, null))
  return {
    concept_id: concept.concept_id,
    value_slot: {
      probability,
      predicted: probability >= 0.5,
      scope: concept.scope,
    },
    confidence: Math.abs(probability - 0.5) * 2,
    evidence_refs: query.state_ref ? [query.state_ref] : [],
  }
}

function predictAggregateCandidateConcept(
  concept: LinearConceptModelConcept,
  query: MlDecisionPoint,
  candidates: readonly MlCandidateAction[],
): RuntimeConceptValue | null {
  const windowCandidates = candidates.filter((c) => {
    const tags = Array.isArray(c.runtime_slots?.candidate_tags)
      ? c.runtime_slots.candidate_tags as string[]
      : []
    return !tags.some((t) => String(t).includes("declareEnd") || String(t).includes("elementalTuning"))
  })

  if (windowCandidates.length === 0) {
    const probability = predictProbability(concept, extractFeatures(query, null))
    return {
      concept_id: concept.concept_id,
      value_slot: {
        probability,
        predicted: probability >= 0.5,
        scope: "aggregate_candidate",
      },
      confidence: Math.abs(probability - 0.5) * 2,
      evidence_refs: query.state_ref ? [query.state_ref] : [],
    }
  }

  const scored = windowCandidates
    .map((candidate) => {
      const baseFeatures = extractFeatures(query, null)
      const candidateFeatures = extractFeatures(query, candidate)
      const mergedFeatures = { ...baseFeatures, ...candidateFeatures }
      return {
        candidate,
        probability: predictProbability(concept, mergedFeatures),
      }
    })
    .sort((left, right) => right.probability - left.probability)

  const top = scored[0]
  if (!top) return null

  const aggregatedProbability = scored.length > 0
    ? scored.reduce((sum, s) => sum + s.probability, 0) / scored.length
    : top.probability

  return {
    concept_id: concept.concept_id,
    value_slot: {
      probability: aggregatedProbability,
      predicted: aggregatedProbability >= 0.5,
      scope: "aggregate_candidate",
      top_candidate_id: top.candidate.candidate_id,
      candidate_coverage: windowCandidates.length / Math.max(1, candidates.length),
    },
    confidence: Math.abs(aggregatedProbability - 0.5) * 2,
    evidence_refs: [top.candidate.candidate_id],
  }
}

function predictProbability(
  concept: LinearConceptModelConcept,
  features: Record<string, number>,
): number {
  let margin = concept.bias
  for (const [key, value] of Object.entries(features)) {
    margin += (concept.feature_weights[key] ?? 0) * value
  }
  return sigmoid(margin)
}

function extractFeatures(
  query: MlDecisionPoint,
  candidate: MlCandidateAction | null,
): Record<string, number> {
  const result: Record<string, number> = {}
  const context = query.context_slots ?? {}

  for (const key of ["round", "actor", "legal_action_count", "point_index", "policy_selected_action_index", "actions_taken_this_round", "turn_phase", "dice_remaining_count"]) {
    const numeric = numericValue(context[key])
    if (numeric != null) {
      result[`query::${key}`] = numeric
    }
  }

  const diceRemainingByElement = context.dice_remaining_by_element
  if (diceRemainingByElement && typeof diceRemainingByElement === "object" && !Array.isArray(diceRemainingByElement)) {
    for (const [elemKey, count] of Object.entries(diceRemainingByElement as Record<string, unknown>)) {
      const numeric = numericValue(count)
      if (numeric != null) {
        result[`query::dice_remaining_by_element.${elemKey}`] = numeric
      }
    }
  }

  const replayActionDefinitionKind = context.replay_action_definition_kind
  if (typeof replayActionDefinitionKind === "string" && replayActionDefinitionKind.length > 0) {
    result[`query::replay_action_definition_kind::${replayActionDefinitionKind}`] = 1
  }

  // Definition ID features: replaced raw ID one-hot with semantic tags
  // for generalization. Read semantic tags from context_slots if available,
  // otherwise skip (the model still has query_numeric_slots with
  // self_effect_family_counts and self_meta_prior_slots for semantic info).
  for (const key of [
    "self_active_character_semantic_tags",
    "opp_active_character_semantic_tags",
  ] as const) {
    const value = context[key]
    if (Array.isArray(value)) {
      for (const tag of value) {
        if (typeof tag === "string") {
          result[`query::${key}::${tag}`] = 1
        }
      }
    }
  }

  const queryNumeric = context.query_numeric_slots
  if (queryNumeric && typeof queryNumeric === "object" && !Array.isArray(queryNumeric)) {
    for (const [path, value] of Object.entries(flattenNumericRecord(queryNumeric as Record<string, unknown>))) {
      result[`query::query_numeric_slots.${path}`] = value
    }
  }

  if (!candidate) {
    return result
  }

  result[`candidate::action_case::${candidate.action_case}`] = 1
  const runtime = candidate.runtime_slots ?? {}
  const tags = runtime.candidate_tags
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (typeof tag === "string") {
        result[`candidate::tag::${tag}`] = 1
      }
    }
  }

  if (typeof runtime.action_definition_kind === "string" && runtime.action_definition_kind.length > 0) {
    result[`candidate::action_definition_kind::${runtime.action_definition_kind}`] = 1
  }

  // NOTE: Candidate definition_id one-hot features removed for generalization.
  // Semantic tags from candidate_tags (e.g. "tag:food", "entity:support")
  // already cover this via `candidate::tag::xxx` features above.
  // The candidate_numeric_slots also contain meta_effect_slots for fine-grained info.

  for (const key of ["is_policy_choice", "is_replay_choice"]) {
    const numeric = numericValue(runtime[key])
    if (numeric != null) {
      result[`candidate::${key}`] = numeric
    }
  }

  for (const key of ["candidate_numeric_slots", "continuation"]) {
    const nested = runtime[key]
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      for (const [path, value] of Object.entries(flattenNumericRecord(nested as Record<string, unknown>))) {
        result[`candidate::${key}.${path}`] = value
      }
    }
  }

  return result
}

import { flattenNumericRecord } from "../utils/flatten.js"

function numericValue(value: unknown): number | null {
  if (typeof value === "boolean") {
    return value ? 1 : 0
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  return null
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const exp = Math.exp(-value)
    return 1 / (1 + exp)
  }
  const exp = Math.exp(value)
  return exp / (1 + exp)
}
