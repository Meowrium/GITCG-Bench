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

import type { JsonValue, MlConceptHypothesis, SlotValue } from "../contracts/index.js"

export interface MergeConceptHypothesesOptions {
  maxEvidenceRefs?: number
}

export function mergeConceptHypotheses(
  inputs: readonly MlConceptHypothesis[],
  options: MergeConceptHypothesesOptions = {},
): MlConceptHypothesis[] {
  const maxEvidenceRefs = options.maxEvidenceRefs ?? 16
  const merged = new Map<string, MlConceptHypothesis>()

  for (const concept of inputs) {
    const previous = merged.get(concept.concept_id)
    if (!previous) {
      merged.set(concept.concept_id, cloneConcept(concept, maxEvidenceRefs))
      continue
    }
    merged.set(
      concept.concept_id,
      mergeConceptPair(previous, concept, maxEvidenceRefs),
    )
  }

  return [...merged.values()].sort((left, right) =>
    left.concept_id.localeCompare(right.concept_id),
  )
}

function mergeConceptPair(
  left: MlConceptHypothesis,
  right: MlConceptHypothesis,
  maxEvidenceRefs: number,
): MlConceptHypothesis {
  const preferred = comparePriority(left, right) >= 0 ? left : right
  const secondary = preferred === left ? right : left

  return {
    ...secondary,
    ...preferred,
    concept_id: preferred.concept_id,
    name: preferred.name,
    scope: preferred.scope,
    description: preferred.description,
    evidence_refs: mergeStringArrays(
      preferred.evidence_refs,
      secondary.evidence_refs,
      maxEvidenceRefs,
    ),
    tags: mergeOptionalStringArrays(preferred.tags, secondary.tags),
    estimator_slot: preferred.estimator_slot ?? secondary.estimator_slot ?? null,
    validation_slot: mergeSlotValues(preferred.validation_slot, secondary.validation_slot),
    ranking_slot: mergeSlotValues(preferred.ranking_slot, secondary.ranking_slot),
    status: preferredStatus(left.status, right.status),
    source: preferred.source ?? secondary.source ?? null,
    created_at: earlierTimestamp(left.created_at, right.created_at),
    updated_at: laterTimestamp(left.updated_at ?? left.created_at, right.updated_at ?? right.created_at),
  }
}

function cloneConcept(concept: MlConceptHypothesis, maxEvidenceRefs: number): MlConceptHypothesis {
  return {
    ...concept,
    evidence_refs: [...concept.evidence_refs].slice(0, maxEvidenceRefs),
    tags: concept.tags ? [...concept.tags] : undefined,
    estimator_slot: concept.estimator_slot ? structuredClone(concept.estimator_slot) : null,
    validation_slot: concept.validation_slot ? structuredClone(concept.validation_slot) : null,
    ranking_slot: concept.ranking_slot ? structuredClone(concept.ranking_slot) : null,
  }
}

function comparePriority(left: MlConceptHypothesis, right: MlConceptHypothesis): number {
  const leftUpdated = Date.parse(left.updated_at ?? left.created_at ?? "")
  const rightUpdated = Date.parse(right.updated_at ?? right.created_at ?? "")
  if (Number.isFinite(leftUpdated) && Number.isFinite(rightUpdated) && leftUpdated !== rightUpdated) {
    return leftUpdated - rightUpdated
  }

  const statusDiff = statusRank(left.status) - statusRank(right.status)
  if (statusDiff !== 0) {
    return statusDiff
  }

  const estimatorDiff = slotComplexity(left.estimator_slot) - slotComplexity(right.estimator_slot)
  if (estimatorDiff !== 0) {
    return estimatorDiff
  }

  const validationDiff = slotComplexity(left.validation_slot) - slotComplexity(right.validation_slot)
  if (validationDiff !== 0) {
    return validationDiff
  }

  const evidenceDiff = left.evidence_refs.length - right.evidence_refs.length
  if (evidenceDiff !== 0) {
    return evidenceDiff
  }

  return left.description.length - right.description.length
}

function statusRank(status: MlConceptHypothesis["status"]): number {
  switch (status) {
    case "validated":
      return 3
    case "draft":
      return 2
    case "deprecated":
      return 1
  }
}

function preferredStatus(
  left: MlConceptHypothesis["status"],
  right: MlConceptHypothesis["status"],
): MlConceptHypothesis["status"] {
  return statusRank(left) >= statusRank(right) ? left : right
}

function mergeStringArrays(
  left: readonly string[],
  right: readonly string[],
  maxLength: number,
): string[] {
  return [...new Set([...left, ...right])].sort().slice(0, maxLength)
}

function mergeOptionalStringArrays(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): string[] | undefined {
  const merged = [...new Set([...(left ?? []), ...(right ?? [])])].sort()
  return merged.length > 0 ? merged : undefined
}

function mergeSlotValues(left: SlotValue | undefined, right: SlotValue | undefined): SlotValue {
  if (!left && !right) {
    return null
  }
  return mergeJsonObjects(right ?? null, left ?? null)
}

function mergeJsonObjects(
  base: Record<string, JsonValue> | null,
  override: Record<string, JsonValue> | null,
): SlotValue {
  if (!base && !override) {
    return null
  }

  const result: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(base ?? {})) {
    result[key] = value
  }
  for (const [key, value] of Object.entries(override ?? {})) {
    const previous = result[key]
    if (
      previous &&
      value &&
      typeof previous === "object" &&
      typeof value === "object" &&
      !Array.isArray(previous) &&
      !Array.isArray(value)
    ) {
      result[key] = mergeJsonObjects(
        previous as Record<string, JsonValue>,
        value as Record<string, JsonValue>,
      ) as JsonValue
      continue
    }
    result[key] = value
  }
  return result
}

function earlierTimestamp(left?: string | null, right?: string | null): string | null {
  const leftTime = Date.parse(left ?? "")
  const rightTime = Date.parse(right ?? "")
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return leftTime <= rightTime ? left ?? null : right ?? null
  }
  return left ?? right ?? null
}

function laterTimestamp(left?: string | null, right?: string | null): string | null {
  const leftTime = Date.parse(left ?? "")
  const rightTime = Date.parse(right ?? "")
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return leftTime >= rightTime ? left ?? null : right ?? null
  }
  return left ?? right ?? null
}

function slotComplexity(slot: SlotValue | undefined): number {
  if (!slot) {
    return 0
  }
  return countJsonLeaves(slot)
}

function countJsonLeaves(value: JsonValue): number {
  if (value == null || typeof value !== "object") {
    return 1
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + countJsonLeaves(item), 0)
  }
  return Object.values(value).reduce<number>((sum, item) => sum + countJsonLeaves(item), 0)
}
