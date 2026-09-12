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
  JsonValue,
  SlotValue,
} from "../contracts/index.js"
import type { RuntimeConceptState } from "../runtime/index.js"
import type { RankedAction, RankRequest, RankResult, ActionRanker } from "./types.js"
import type {
  ConceptNumericWeight,
  SlotLinearRankerArtifact,
  SlotLinearRankerConfig,
} from "./artifact.js"

export class SlotLinearRanker implements ActionRanker {
  readonly artifact: SlotLinearRankerArtifact

  constructor(artifact: SlotLinearRankerArtifact) {
    this.artifact = artifact
  }

  async rank(request: RankRequest): Promise<RankResult> {
    return this.rankSync(request)
  }

  rankSync(request: RankRequest): RankResult {
    const ranked = request.candidates
      .map((candidate) => this.rankCandidate(request.query, candidate, request.concept_state ?? null))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score
        }
        return left.candidate_id.localeCompare(right.candidate_id)
      })

    return {
      query_id: request.query.query_id,
      ranked_actions: ranked,
      summary_slots: {
        artifact_type: this.artifact.artifact_type,
        artifact_version: this.artifact.artifact_version,
        candidate_count: ranked.length,
      },
    }
  }

  private rankCandidate(
    query: MlDecisionPoint,
    candidate: MlCandidateAction,
    conceptState: RuntimeConceptState | null,
  ): RankedAction {
    const config = this.artifact.config
    const contributions: Record<string, JsonValue> = {}
    let score = 0

    score += applyActionCaseBias(config, candidate, contributions)
    score += applyCandidateTagBias(config, candidate, contributions)
    score += applyNumericSlotWeights(
      "candidate_numeric_slot_weights",
      config.candidate_numeric_slot_weights,
      candidate.runtime_slots ?? null,
      contributions,
    )
    score += applyNumericSlotWeights(
      "query_numeric_slot_weights",
      config.query_numeric_slot_weights,
      query.context_slots ?? null,
      contributions,
    )
    score += applyConceptPresenceWeights(config, conceptState, contributions)
    score += applyConceptNumericWeights(config, conceptState, contributions)

    return {
      candidate_id: candidate.candidate_id,
      score,
      explanation_slots: {
        action_case: candidate.action_case,
        score,
        contributions,
      },
    }
  }
}

function applyActionCaseBias(
  config: SlotLinearRankerConfig,
  candidate: MlCandidateAction,
  contributions: Record<string, JsonValue>,
): number {
  const bias = config.action_case_bias?.[candidate.action_case] ?? 0
  contributions.action_case_bias = bias
  return bias
}

function applyCandidateTagBias(
  config: SlotLinearRankerConfig,
  candidate: MlCandidateAction,
  contributions: Record<string, JsonValue>,
): number {
  const tags = extractRuntimeTags(candidate.runtime_slots)
  const total = tags.reduce(
    (sum, tag) => sum + (config.candidate_tag_bias?.[tag] ?? 0),
    0,
  )
  contributions.candidate_tag_bias = total
  contributions.candidate_tags = tags
  return total
}

function applyNumericSlotWeights(
  label: string,
  weights: Record<string, number> | undefined,
  slot: SlotValue,
  contributions: Record<string, JsonValue>,
): number {
  if (!weights || !slot) {
    contributions[label] = 0
    return 0
  }

  let total = 0
  const detail: Record<string, JsonValue> = {}

  for (const [path, weight] of Object.entries(weights)) {
    const value = numericValueAtPath(slot, path)
    if (value == null) {
      continue
    }
    const contribution = value * weight
    detail[path] = contribution
    total += contribution
  }

  contributions[label] = detail
  return total
}

function applyConceptPresenceWeights(
  config: SlotLinearRankerConfig,
  conceptState: RuntimeConceptState | null,
  contributions: Record<string, JsonValue>,
): number {
  if (!config.concept_presence_weights || !conceptState) {
    contributions.concept_presence_weights = 0
    return 0
  }

  let total = 0
  const detail: Record<string, JsonValue> = {}

  for (const [conceptId, weight] of Object.entries(config.concept_presence_weights)) {
    const concept = conceptState.values.find((value) => value.concept_id === conceptId)
    if (!concept) {
      continue
    }
    total += weight
    detail[conceptId] = weight
  }

  contributions.concept_presence_weights = detail
  return total
}

function applyConceptNumericWeights(
  config: SlotLinearRankerConfig,
  conceptState: RuntimeConceptState | null,
  contributions: Record<string, JsonValue>,
): number {
  if (!config.concept_numeric_slot_weights || !conceptState) {
    contributions.concept_numeric_slot_weights = 0
    return 0
  }

  let total = 0
  const detail: Record<string, JsonValue> = {}
  for (const item of config.concept_numeric_slot_weights) {
    const contribution = conceptNumericContribution(conceptState, item)
    if (!contribution) {
      continue
    }
    const weighted = contribution.value * item.weight
    total += weighted
    detail[`${item.concept_id}.${item.path}`] = weighted
  }
  contributions.concept_numeric_slot_weights = detail
  return total
}

function conceptNumericContribution(
  state: RuntimeConceptState,
  item: ConceptNumericWeight,
): { value: number } | null {
  const concept = state.values.find((value) => value.concept_id === item.concept_id)
  if (!concept || !concept.value_slot) {
    return null
  }
  const numeric = numericValueAtPath(concept.value_slot, item.path)
  if (numeric == null) {
    return null
  }
  return { value: numeric }
}

function numericValueAtPath(slot: SlotValue, path: string): number | null {
  if (!slot) {
    return null
  }
  const parts = path.split(".").filter(Boolean)
  let current: JsonValue | undefined = slot
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return null
    }
    current = current[part]
  }
  if (typeof current === "number") {
    return current
  }
  if (typeof current === "boolean") {
    return current ? 1 : 0
  }
  return null
}

function extractStringArray(slot: SlotValue | undefined, key: string): string[] {
  if (!slot) {
    return []
  }
  const value = slot[key]
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

function extractRuntimeTags(slot: SlotValue | undefined): string[] {
  const tags = extractStringArray(slot, "candidate_tags")
  if (!slot) {
    return tags
  }

  const actionKind = slot.action_definition_kind
  if (typeof actionKind === "string" && actionKind.length > 0) {
    tags.push(`action_kind::${actionKind}`)
  }

  // NOTE: definition_id one-hot tags (e.g. "card_definition_id::1234") were removed
  // to improve generalization. The model now relies on semantic tags from
  // static_effect_tags (e.g. "tag:food", "entity:support", "element:pyro")
  // which are already included in candidate_tags. This means new/unseen cards
  // with known tags will automatically receive reasonable bias estimates.

  return tags
}
