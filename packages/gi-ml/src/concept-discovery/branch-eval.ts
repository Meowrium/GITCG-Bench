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
  MlConceptHypothesis,
  MlPairwisePreference,
  MlRankingDataset,
  MlRankingQueryGroup,
  SlotValue,
} from "../contracts/index.js"

export interface BranchEvalConceptDiscoveryOptions {
  minSupport?: number
  minMeanConfidence?: number
  continuationGapThreshold?: number
  maxEvidenceRefsPerConcept?: number
  includeActionCaseConcepts?: boolean
  includeCandidateTagConcepts?: boolean
  includeActionCaseTagConcepts?: boolean
  includeActorCharacterConcepts?: boolean
  includeSkillDefinitionConcepts?: boolean
  includeCardDefinitionConcepts?: boolean
  includeCharacterDefinitionConcepts?: boolean
  includeActionEntityConcepts?: boolean
}

interface SignalRecord {
  kind:
    | "action_case"
    | "candidate_tag"
    | "action_case_tag"
    | "actor_character"
    | "skill_definition"
    | "card_definition"
    | "character_definition"
    | "action_entity"
  key: string
  support_count: number
  total_confidence: number
  evidence_refs: Set<string>
  action_case?: string
  candidate_tag?: string
  action_definition_kind?: string
  skill_definition_id?: number
  card_definition_id?: number
  character_definition_id?: number
  actor_character_definition_id?: number
}

export function extractConceptHypothesesFromBranchEvalDataset(
  dataset: MlRankingDataset,
  options: BranchEvalConceptDiscoveryOptions = {},
): MlConceptHypothesis[] {
  const stats = collectSignalStats(dataset, options)
  const minSupport = options.minSupport ?? 2
  const minMeanConfidence = options.minMeanConfidence ?? 0.15
  const maxEvidenceRefs = options.maxEvidenceRefsPerConcept ?? 8

  return [...stats.values()]
    .filter((item) => item.support_count >= minSupport)
    .filter((item) => item.total_confidence / item.support_count >= minMeanConfidence)
    .map((item) => buildConceptHypothesis(item, dataset, maxEvidenceRefs))
    .sort((left, right) => left.concept_id.localeCompare(right.concept_id))
}

function collectSignalStats(
  dataset: MlRankingDataset,
  options: BranchEvalConceptDiscoveryOptions,
): Map<string, SignalRecord> {
  const stats = new Map<string, SignalRecord>()

  for (const group of dataset.query_groups) {
    const candidatesById = new Map(
      group.candidates.map((candidate) => [candidate.candidate_id, candidate]),
    )

    const signals = group.pairwise_preferences && group.pairwise_preferences.length > 0
      ? extractSignalsFromPreferences(group, candidatesById)
      : extractSignalsFromContinuation(group, options.continuationGapThreshold ?? 0.2)

    for (const signal of signals) {
      if (options.includeActionCaseConcepts !== false) {
        addSignal(
          stats,
          "action_case",
          signal.candidate.action_case,
          signal.confidence,
          signal.evidence_ref,
          {
            action_case: signal.candidate.action_case,
          },
        )
      }

      const tags = extractCandidateTags(signal.candidate)
      if (options.includeCandidateTagConcepts !== false) {
        for (const tag of tags) {
          addSignal(
            stats,
            "candidate_tag",
            tag,
            signal.confidence,
            signal.evidence_ref,
            {
              candidate_tag: tag,
            },
          )
        }
      }

      if (options.includeActionCaseTagConcepts !== false) {
        for (const tag of tags) {
          addSignal(
            stats,
            "action_case_tag",
            `${signal.candidate.action_case}::${tag}`,
            signal.confidence,
            signal.evidence_ref,
            {
              action_case: signal.candidate.action_case,
              candidate_tag: tag,
            },
          )
        }
      }

      const identities = extractCandidateIdentities(signal.candidate)
      if (
        options.includeActorCharacterConcepts !== false &&
        identities.actor_character_definition_id != null
      ) {
        addSignal(
          stats,
          "actor_character",
          String(identities.actor_character_definition_id),
          signal.confidence,
          signal.evidence_ref,
          {
            actor_character_definition_id: identities.actor_character_definition_id,
          },
        )
      }
      if (options.includeSkillDefinitionConcepts !== false && identities.skill_definition_id != null) {
        addSignal(
          stats,
          "skill_definition",
          String(identities.skill_definition_id),
          signal.confidence,
          signal.evidence_ref,
          {
            action_definition_kind: "skill",
            skill_definition_id: identities.skill_definition_id,
          },
        )
      }
      if (options.includeCardDefinitionConcepts !== false && identities.card_definition_id != null) {
        addSignal(
          stats,
          "card_definition",
          String(identities.card_definition_id),
          signal.confidence,
          signal.evidence_ref,
          {
            action_definition_kind: "card",
            card_definition_id: identities.card_definition_id,
          },
        )
      }
      if (
        options.includeCharacterDefinitionConcepts !== false &&
        identities.character_definition_id != null
      ) {
        addSignal(
          stats,
          "character_definition",
          String(identities.character_definition_id),
          signal.confidence,
          signal.evidence_ref,
          {
            action_definition_kind: "character",
            character_definition_id: identities.character_definition_id,
          },
        )
      }
      if (options.includeActionEntityConcepts !== false) {
        const entityRule = primaryEntityAttrs(signal.candidate)
        if (entityRule) {
          addSignal(
            stats,
            "action_entity",
            `${signal.candidate.action_case}::${entityRule.key}`,
            signal.confidence,
            signal.evidence_ref,
            {
              action_case: signal.candidate.action_case,
              ...entityRule.attrs,
            },
          )
        }
      }
    }
  }

  return stats
}

function extractSignalsFromPreferences(
  group: MlRankingQueryGroup,
  candidatesById: Map<string, MlCandidateAction>,
): Array<{ candidate: MlCandidateAction; confidence: number; evidence_ref: string }> {
  const result: Array<{ candidate: MlCandidateAction; confidence: number; evidence_ref: string }> = []
  for (const preference of group.pairwise_preferences ?? []) {
    const winner = preferredCandidate(preference, candidatesById)
    if (!winner) {
      continue
    }
    result.push({
      candidate: winner,
      confidence: pairwiseConfidence(preference),
      evidence_ref: preference.evidence_ref ?? winner.branch_eval_ref ?? group.query_id,
    })
  }
  return result
}

function extractSignalsFromContinuation(
  group: MlRankingQueryGroup,
  continuationGapThreshold: number,
): Array<{ candidate: MlCandidateAction; confidence: number; evidence_ref: string }> {
  const scored = group.candidates
    .map((candidate) => ({
      candidate,
      score: continuationScore(candidate),
    }))
    .sort((left, right) => right.score - left.score)

  const top = scored[0]
  const runnerUp = scored[1]
  if (!top || !runnerUp) {
    return []
  }
  const gap = top.score - runnerUp.score
  if (gap < continuationGapThreshold) {
    return []
  }

  return [
    {
      candidate: top.candidate,
      confidence: gap,
      evidence_ref: top.candidate.branch_eval_ref ?? group.query_id,
    },
  ]
}

function addSignal(
  stats: Map<string, SignalRecord>,
  kind: SignalRecord["kind"],
  key: string,
  confidence: number,
  evidenceRef: string,
  attrs: {
    action_case?: string
    candidate_tag?: string
    action_definition_kind?: string
    skill_definition_id?: number
    card_definition_id?: number
    character_definition_id?: number
    actor_character_definition_id?: number
  },
) {
  const mapKey = `${kind}:${key}`
  const current = stats.get(mapKey) ?? {
    kind,
    key,
    support_count: 0,
    total_confidence: 0,
    evidence_refs: new Set<string>(),
    action_case: attrs.action_case,
    candidate_tag: attrs.candidate_tag,
    action_definition_kind: attrs.action_definition_kind,
    skill_definition_id: attrs.skill_definition_id,
    card_definition_id: attrs.card_definition_id,
    character_definition_id: attrs.character_definition_id,
    actor_character_definition_id: attrs.actor_character_definition_id,
  }
  current.support_count += 1
  current.total_confidence += confidence
  current.evidence_refs.add(evidenceRef)
  stats.set(mapKey, current)
}

function buildConceptHypothesis(
  record: SignalRecord,
  dataset: MlRankingDataset,
  maxEvidenceRefs: number,
): MlConceptHypothesis {
  const createdAt = dataset.created_at ?? new Date().toISOString()
  const meanConfidence = record.total_confidence / Math.max(1, record.support_count)
  const estimatorSlot = buildEstimatorSlot(record)

  return {
    concept_id: buildConceptId(record),
    name: buildConceptName(record),
    scope: "state_action",
    description: buildConceptDescription(record, meanConfidence),
    evidence_refs: [...record.evidence_refs].sort().slice(0, maxEvidenceRefs),
    tags: buildConceptTags(record),
    estimator_slot: estimatorSlot,
    validation_slot: {
      source_dataset_id: dataset.dataset_id,
      support_count: record.support_count,
      mean_confidence: meanConfidence,
      discovery_method: "branch_eval_preference_aggregation.v1",
    },
    ranking_slot: {
      source: "branch_eval",
      score_hint: meanConfidence,
    },
    status: "draft",
    source: "branch_eval",
    created_at: createdAt,
    updated_at: createdAt,
  }
}

function buildEstimatorSlot(record: SignalRecord): SlotValue {
  if (record.kind === "action_case" && record.action_case) {
    return {
      action_case: record.action_case,
    }
  }
  if (record.kind === "candidate_tag" && record.candidate_tag) {
    return {
      candidate_tag: record.candidate_tag,
    }
  }
  const parts: Array<Record<string, string | number>> = []
  if (record.action_case) {
    parts.push({ action_case: record.action_case })
  }
  if (record.candidate_tag) {
    parts.push({ candidate_tag: record.candidate_tag })
  }
  if (record.action_definition_kind) {
    parts.push({ action_definition_kind: record.action_definition_kind })
  }
  if (record.skill_definition_id != null) {
    parts.push({ skill_definition_id: record.skill_definition_id })
  }
  if (record.card_definition_id != null) {
    parts.push({ card_definition_id: record.card_definition_id })
  }
  if (record.character_definition_id != null) {
    parts.push({ character_definition_id: record.character_definition_id })
  }
  if (record.actor_character_definition_id != null) {
    parts.push({ actor_character_definition_id: record.actor_character_definition_id })
  }
  if (parts.length === 0) {
    return null
  }
  if (parts.length === 1) {
    return parts[0]!
  }
  return { all_of: parts }
}

function buildConceptId(record: SignalRecord): string {
  if (record.kind === "action_case") {
    return `concept:branch-eval:action-case:${slugify(record.key)}`
  }
  if (record.kind === "candidate_tag") {
    return `concept:branch-eval:candidate-tag:${slugify(record.key)}`
  }
  if (record.kind === "actor_character") {
    return `concept:branch-eval:actor-character:${slugify(record.key)}`
  }
  if (record.kind === "skill_definition") {
    return `concept:branch-eval:skill-definition:${slugify(record.key)}`
  }
  if (record.kind === "card_definition") {
    return `concept:branch-eval:card-definition:${slugify(record.key)}`
  }
  if (record.kind === "character_definition") {
    return `concept:branch-eval:character-definition:${slugify(record.key)}`
  }
  if (record.kind === "action_entity") {
    return `concept:branch-eval:action-entity:${slugify(record.key)}`
  }
  return `concept:branch-eval:action-tag:${slugify(record.key)}`
}

function buildConceptName(record: SignalRecord): string {
  if (record.kind === "action_case") {
    return `branch-eval-action-case-${record.key}`
  }
  if (record.kind === "candidate_tag") {
    return `branch-eval-candidate-tag-${record.key}`
  }
  if (record.kind === "actor_character") {
    return `branch-eval-actor-character-${record.key}`
  }
  if (record.kind === "skill_definition") {
    return `branch-eval-skill-definition-${record.key}`
  }
  if (record.kind === "card_definition") {
    return `branch-eval-card-definition-${record.key}`
  }
  if (record.kind === "character_definition") {
    return `branch-eval-character-definition-${record.key}`
  }
  if (record.kind === "action_entity") {
    return `branch-eval-action-entity-${record.key.replaceAll("::", "-")}`
  }
  return `branch-eval-action-tag-${record.key.replaceAll("::", "-")}`
}

function buildConceptDescription(record: SignalRecord, meanConfidence: number): string {
  if (record.kind === "action_case") {
    return `Preferred branch-eval pattern: action_case=${record.action_case}; support=${record.support_count}; mean_confidence=${meanConfidence.toFixed(3)}`
  }
  if (record.kind === "candidate_tag") {
    return `Preferred branch-eval pattern: candidate_tag=${record.candidate_tag}; support=${record.support_count}; mean_confidence=${meanConfidence.toFixed(3)}`
  }
  if (record.kind === "actor_character") {
    return `Preferred branch-eval pattern: actor_character_definition_id=${record.actor_character_definition_id}; support=${record.support_count}; mean_confidence=${meanConfidence.toFixed(3)}`
  }
  if (record.kind === "skill_definition") {
    return `Preferred branch-eval pattern: skill_definition_id=${record.skill_definition_id}; support=${record.support_count}; mean_confidence=${meanConfidence.toFixed(3)}`
  }
  if (record.kind === "card_definition") {
    return `Preferred branch-eval pattern: card_definition_id=${record.card_definition_id}; support=${record.support_count}; mean_confidence=${meanConfidence.toFixed(3)}`
  }
  if (record.kind === "character_definition") {
    return `Preferred branch-eval pattern: character_definition_id=${record.character_definition_id}; support=${record.support_count}; mean_confidence=${meanConfidence.toFixed(3)}`
  }
  if (record.kind === "action_entity") {
    return `Preferred branch-eval pattern: action_case=${record.action_case} with entity=${record.key.split("::").slice(1).join("::")}; support=${record.support_count}; mean_confidence=${meanConfidence.toFixed(3)}`
  }
  return `Preferred branch-eval pattern: action_case=${record.action_case} with candidate_tag=${record.candidate_tag}; support=${record.support_count}; mean_confidence=${meanConfidence.toFixed(3)}`
}

function buildConceptTags(record: SignalRecord): string[] {
  return [
    "branch_eval",
    "preferred_pattern",
    record.kind,
    record.action_case,
    record.candidate_tag,
    record.action_definition_kind,
    record.skill_definition_id != null ? `skill_${record.skill_definition_id}` : null,
    record.card_definition_id != null ? `card_${record.card_definition_id}` : null,
    record.character_definition_id != null ? `character_${record.character_definition_id}` : null,
    record.actor_character_definition_id != null
      ? `actor_${record.actor_character_definition_id}`
      : null,
  ].filter((item): item is string => Boolean(item))
}

function preferredCandidate(
  preference: MlPairwisePreference,
  candidatesById: Map<string, MlCandidateAction>,
): MlCandidateAction | null {
  if (preference.preference_label > 0) {
    return candidatesById.get(preference.candidate_a_id) ?? null
  }
  if (preference.preference_label < 0) {
    return candidatesById.get(preference.candidate_b_id) ?? null
  }
  return null
}

function pairwiseConfidence(preference: MlPairwisePreference): number {
  if (typeof preference.confidence === "number" && Number.isFinite(preference.confidence)) {
    return Math.abs(preference.confidence)
  }
  const slots = preference.preference_slots
  if (slots) {
    const left = numericValue(slots.continuation_score_a)
    const right = numericValue(slots.continuation_score_b)
    if (left != null && right != null) {
      return Math.abs(left - right)
    }
  }
  return 1
}

function continuationScore(candidate: MlCandidateAction): number {
  const continuation = candidate.runtime_slots?.continuation
  if (!continuation || typeof continuation !== "object" || Array.isArray(continuation)) {
    return 0
  }
  const score = numericValue((continuation as Record<string, unknown>).score)
  if (score != null) {
    return score
  }
  return numericValue((continuation as Record<string, unknown>).win_rate) ?? 0
}

function extractCandidateTags(candidate: MlCandidateAction): string[] {
  const raw = candidate.runtime_slots?.candidate_tags
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string")
    : []
}

function extractCandidateIdentities(candidate: MlCandidateAction): {
  action_definition_kind?: string
  skill_definition_id?: number
  card_definition_id?: number
  character_definition_id?: number
  actor_character_definition_id?: number
} {
  const runtime = candidate.runtime_slots
  return {
    action_definition_kind:
      typeof runtime?.action_definition_kind === "string"
        ? runtime.action_definition_kind
        : undefined,
    skill_definition_id: numericValue(runtime?.skill_definition_id) ?? undefined,
    card_definition_id: numericValue(runtime?.card_definition_id) ?? undefined,
    character_definition_id: numericValue(runtime?.character_definition_id) ?? undefined,
    actor_character_definition_id:
      numericValue(runtime?.actor_character_definition_id) ?? undefined,
  }
}

function primaryEntityAttrs(candidate: MlCandidateAction): {
  key: string
  attrs: {
    action_definition_kind?: string
    skill_definition_id?: number
    card_definition_id?: number
    character_definition_id?: number
    actor_character_definition_id?: number
  }
} | null {
  const identities = extractCandidateIdentities(candidate)
  if (identities.skill_definition_id != null) {
    return {
      key: `skill::${identities.skill_definition_id}`,
      attrs: {
        action_definition_kind: "skill",
        skill_definition_id: identities.skill_definition_id,
      },
    }
  }
  if (identities.card_definition_id != null) {
    return {
      key: `card::${identities.card_definition_id}`,
      attrs: {
        action_definition_kind: "card",
        card_definition_id: identities.card_definition_id,
      },
    }
  }
  if (identities.character_definition_id != null) {
    return {
      key: `character::${identities.character_definition_id}`,
      attrs: {
        action_definition_kind: "character",
        character_definition_id: identities.character_definition_id,
      },
    }
  }
  if (identities.actor_character_definition_id != null) {
    return {
      key: `actor::${identities.actor_character_definition_id}`,
      attrs: {
        actor_character_definition_id: identities.actor_character_definition_id,
      },
    }
  }
  return null
}

function numericValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}
