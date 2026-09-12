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

export interface BranchEvalComboConceptDiscoveryOptions {
  minSupport?: number
  minMeanConfidence?: number
  maxEvidenceRefsPerConcept?: number
  minComboSteps?: number
  maxComboSteps?: number
  maxPointGap?: number
}

interface ComboStep {
  action_case: string
  candidate_tag?: string
  action_definition_kind?: string
  skill_definition_id?: number
  card_definition_id?: number
  character_definition_id?: number
  actor_character_definition_id?: number
}

interface ComboSignalRecord {
  key: string
  support_count: number
  total_confidence: number
  evidence_refs: Set<string>
  steps: ComboStep[]
  max_point_gap: number
}

interface ParsedQueryRef {
  matchup_id: string
  replay_file: string
  point_index: number
}

interface ReplayPoint {
  ref: ParsedQueryRef
  group: MlRankingQueryGroup
}

export function extractComboConceptHypothesesFromBranchEvalDataset(
  dataset: MlRankingDataset,
  options: BranchEvalComboConceptDiscoveryOptions = {},
): MlConceptHypothesis[] {
  const stats = collectComboSignalStats(dataset, options)
  const minSupport = options.minSupport ?? 2
  const minMeanConfidence = options.minMeanConfidence ?? 0.15
  const maxEvidenceRefs = options.maxEvidenceRefsPerConcept ?? 8

  return [...stats.values()]
    .filter((item) => item.support_count >= minSupport)
    .filter((item) => item.total_confidence / item.support_count >= minMeanConfidence)
    .map((item) => buildComboConceptHypothesis(item, dataset, maxEvidenceRefs))
    .sort((left, right) => left.concept_id.localeCompare(right.concept_id))
}

function collectComboSignalStats(
  dataset: MlRankingDataset,
  options: BranchEvalComboConceptDiscoveryOptions,
): Map<string, ComboSignalRecord> {
  const stats = new Map<string, ComboSignalRecord>()
  const replays = groupReplayPoints(dataset)
  const minComboSteps = Math.max(2, options.minComboSteps ?? 2)
  const maxComboSteps = Math.max(minComboSteps, options.maxComboSteps ?? 4)
  const maxPointGap = Math.max(1, options.maxPointGap ?? 12)

  for (const replay of replays.values()) {
    for (let index = 0; index < replay.length; index += 1) {
      const anchorPoint = replay[index]!
      const anchorCandidate = preferredSelectedCandidate(anchorPoint.group)
      if (!anchorCandidate) {
        continue
      }
      const anchorConfidence = preferredSelectedConfidence(anchorPoint.group, anchorCandidate.candidate_id)
      if (anchorConfidence == null) {
        continue
      }

      const steps: ComboStep[] = [candidateToStep(anchorCandidate)]
      let previousPointIndex = anchorPoint.ref.point_index

      for (let nextIndex = index + 1; nextIndex < replay.length && steps.length < maxComboSteps; nextIndex += 1) {
        const nextPoint = replay[nextIndex]!
        if (nextPoint.ref.point_index - previousPointIndex > maxPointGap) {
          break
        }
        const nextSelected = selectedCandidate(nextPoint.group)
        if (!nextSelected) {
          continue
        }
        steps.push(candidateToStep(nextSelected))
        previousPointIndex = nextPoint.ref.point_index
      }

      for (let length = minComboSteps; length <= steps.length; length += 1) {
        addComboSignal(
          stats,
          steps.slice(0, length),
          maxPointGap,
          anchorConfidence,
          anchorCandidate.branch_eval_ref ?? anchorPoint.group.query_id,
        )
      }
    }
  }

  return stats
}

function groupReplayPoints(dataset: MlRankingDataset): Map<string, ReplayPoint[]> {
  const result = new Map<string, ReplayPoint[]>()
  for (const group of dataset.query_groups) {
    const parsed = parseBranchEvalQueryRef(group.query_id)
    if (!parsed) {
      continue
    }
    const key = `${parsed.matchup_id}::${parsed.replay_file}`
    const current = result.get(key) ?? []
    current.push({
      ref: parsed,
      group,
    })
    result.set(key, current)
  }

  for (const replay of result.values()) {
    replay.sort((left, right) => left.ref.point_index - right.ref.point_index)
  }
  return result
}

function addComboSignal(
  stats: Map<string, ComboSignalRecord>,
  steps: ComboStep[],
  maxPointGap: number,
  confidence: number,
  evidenceRef: string,
) {
  const key = steps
    .map(
      (step) =>
        [
          step.action_case,
          step.candidate_tag ?? "_",
          step.action_definition_kind ?? "_",
          step.skill_definition_id ?? "_",
          step.card_definition_id ?? "_",
          step.character_definition_id ?? "_",
          step.actor_character_definition_id ?? "_",
        ].join("::"),
    )
    .join(">>>")
  const current = stats.get(key) ?? {
    key,
    support_count: 0,
    total_confidence: 0,
    evidence_refs: new Set<string>(),
    steps,
    max_point_gap: maxPointGap,
  }
  current.support_count += 1
  current.total_confidence += confidence
  current.evidence_refs.add(evidenceRef)
  stats.set(key, current)
}

function buildComboConceptHypothesis(
  record: ComboSignalRecord,
  dataset: MlRankingDataset,
  maxEvidenceRefs: number,
): MlConceptHypothesis {
  const createdAt = dataset.created_at ?? new Date().toISOString()
  const meanConfidence = record.total_confidence / Math.max(1, record.support_count)

  return {
    concept_id: buildConceptId(record),
    name: buildConceptName(record),
    scope: "state_action",
    description: buildConceptDescription(record, meanConfidence),
    evidence_refs: [...record.evidence_refs].sort().slice(0, maxEvidenceRefs),
    tags: [
      "branch_eval",
      "combo_pattern",
      "multi_step",
      `combo_len_${record.steps.length}`,
      ...record.steps.flatMap((step) => [
        step.action_case,
        step.candidate_tag,
        step.action_definition_kind,
        step.skill_definition_id != null ? `skill_${step.skill_definition_id}` : null,
        step.card_definition_id != null ? `card_${step.card_definition_id}` : null,
        step.character_definition_id != null ? `character_${step.character_definition_id}` : null,
        step.actor_character_definition_id != null
          ? `actor_${step.actor_character_definition_id}`
          : null,
      ]),
    ].filter((item): item is string => Boolean(item)),
    estimator_slot: buildEstimatorSlot(record),
    validation_slot: {
      source_dataset_id: dataset.dataset_id,
      support_count: record.support_count,
      mean_confidence: meanConfidence,
      sequence_length: record.steps.length,
      max_point_gap: record.max_point_gap,
      discovery_method: "branch_eval_window_combo.v2",
    },
    ranking_slot: {
      source: "branch_eval",
      score_hint: meanConfidence,
      combo_role: "multi_step_state_action_pattern",
      sequence_length: record.steps.length,
    },
    status: "draft",
    source: "branch_eval",
    created_at: createdAt,
    updated_at: createdAt,
  }
}

function buildEstimatorSlot(record: ComboSignalRecord): SlotValue {
  return {
    kind: "combo_pattern.v1",
    in_order: record.steps.map((step) => buildStepEstimator(step)),
    max_step_gap: record.max_point_gap,
  }
}

function buildStepEstimator(step: ComboStep): NonNullable<SlotValue> {
  if (!step.candidate_tag) {
    return compactRuleFields(step)
  }
  return compactRuleFields(step, { candidate_tag: step.candidate_tag })
}

function buildConceptId(record: ComboSignalRecord): string {
  return `concept:branch-eval:combo:${slugify(record.key)}`
}

function buildConceptName(record: ComboSignalRecord): string {
  return `branch-eval-combo-${record.steps.map((step) => stepToLabel(step)).join("-to-")}`
}

function buildConceptDescription(record: ComboSignalRecord, meanConfidence: number): string {
  return `Windowed branch-eval combo pattern: ${record.steps.map((step) => stepToLabel(step)).join(" -> ")}; support=${record.support_count}; mean_confidence=${meanConfidence.toFixed(3)}; max_point_gap=${record.max_point_gap}`
}

function candidateToStep(candidate: MlCandidateAction): ComboStep {
  const runtime = candidate.runtime_slots
  return {
    action_case: candidate.action_case,
    candidate_tag: extractCandidateTags(candidate)[0],
    action_definition_kind:
      typeof runtime?.action_definition_kind === "string"
        ? runtime.action_definition_kind
        : undefined,
    skill_definition_id: numericRuntimeId(runtime?.skill_definition_id),
    card_definition_id: numericRuntimeId(runtime?.card_definition_id),
    character_definition_id: numericRuntimeId(runtime?.character_definition_id),
    actor_character_definition_id: numericRuntimeId(runtime?.actor_character_definition_id),
  }
}

function stepToLabel(step: ComboStep): string {
  const parts = [step.action_case]
  if (step.candidate_tag) {
    parts.push(step.candidate_tag)
  }
  if (step.skill_definition_id != null) {
    parts.push(`skill#${step.skill_definition_id}`)
  }
  if (step.card_definition_id != null) {
    parts.push(`card#${step.card_definition_id}`)
  }
  if (step.character_definition_id != null) {
    parts.push(`char#${step.character_definition_id}`)
  }
  if (step.actor_character_definition_id != null) {
    parts.push(`actor#${step.actor_character_definition_id}`)
  }
  return parts.join("+")
}

function preferredSelectedCandidate(group: MlRankingQueryGroup): MlCandidateAction | null {
  const selected = selectedCandidate(group)
  if (!selected) {
    return null
  }

  const preferredIds = new Set(
    (group.pairwise_preferences ?? [])
      .map((preference) => preferredCandidateId(preference))
      .filter((item): item is string => Boolean(item)),
  )
  return preferredIds.has(selected.candidate_id) ? selected : null
}

function preferredSelectedConfidence(group: MlRankingQueryGroup, candidateId: string): number | null {
  const confidences = (group.pairwise_preferences ?? [])
    .filter((preference) => preferredCandidateId(preference) === candidateId)
    .map((preference) => pairwiseConfidence(preference))
  if (confidences.length === 0) {
    return null
  }
  return confidences.reduce((sum, value) => sum + value, 0) / confidences.length
}

function selectedCandidate(group: MlRankingQueryGroup): MlCandidateAction | null {
  const selectedIndex = group.context_slots?.policy_selected_action_index
  const selectedType = group.context_slots?.policy_selected_action_type

  const byIndex = group.candidates.find(
    (candidate) =>
      typeof selectedIndex === "number" &&
      candidate.runtime_slots?.branch_action_index === selectedIndex,
  )
  if (byIndex) {
    return byIndex
  }
  if (typeof selectedType === "string") {
    return group.candidates.find((candidate) => candidate.action_case === selectedType) ?? null
  }
  return null
}

function preferredCandidateId(preference: MlPairwisePreference): string | null {
  if (preference.preference_label > 0) {
    return preference.candidate_a_id
  }
  if (preference.preference_label < 0) {
    return preference.candidate_b_id
  }
  return null
}

function pairwiseConfidence(preference: MlPairwisePreference): number {
  if (typeof preference.confidence === "number" && Number.isFinite(preference.confidence)) {
    return Math.abs(preference.confidence)
  }
  return 1
}

function extractCandidateTags(candidate: MlCandidateAction): string[] {
  const raw = candidate.runtime_slots?.candidate_tags
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string")
    : []
}

function compactRuleFields(
  step: ComboStep,
  extra: Record<string, string | number> = {},
): NonNullable<SlotValue> {
  const parts = [
    { action_case: step.action_case },
    step.action_definition_kind != null
      ? { action_definition_kind: step.action_definition_kind }
      : null,
    step.skill_definition_id != null ? { skill_definition_id: step.skill_definition_id } : null,
    step.card_definition_id != null ? { card_definition_id: step.card_definition_id } : null,
    step.character_definition_id != null
      ? { character_definition_id: step.character_definition_id }
      : null,
    step.actor_character_definition_id != null
      ? { actor_character_definition_id: step.actor_character_definition_id }
      : null,
    ...Object.entries(extra)
      .filter(([, value]) => value != null)
      .map(([key, value]) => ({ [key]: value })),
  ].filter((item): item is Record<string, string | number> => Boolean(item))

  if (parts.length === 1) {
    return parts[0]!
  }
  return {
    all_of: parts,
  }
}

function numericRuntimeId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function parseBranchEvalQueryRef(queryId: string): ParsedQueryRef | null {
  const parts = queryId.split(":")
  if (parts.length < 5 || parts[0] !== "branch_eval") {
    return null
  }
  const point = parts[4]
  if (!point?.startsWith("point_")) {
    return null
  }
  const pointIndex = Number(point.slice("point_".length))
  if (!Number.isInteger(pointIndex)) {
    return null
  }
  return {
    matchup_id: parts[1]!,
    replay_file: parts[2]!,
    point_index: pointIndex,
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}
