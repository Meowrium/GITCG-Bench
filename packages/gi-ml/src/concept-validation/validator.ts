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
  JsonValue,
  MlConceptStatus,
  SlotValue,
} from "../contracts/index.js"
import type {
  ConceptValidationRequest,
  ConceptValidationResult,
  ConceptValidator,
} from "./types.js"

export interface ConceptValidationThresholds {
  min_evidence_refs?: number
  required_numeric_slots?: Record<string, number>
  maximum_numeric_slots?: Record<string, number>
  required_truthy_slots?: string[]
  promotable_statuses?: MlConceptStatus[]
  rejected_statuses?: MlConceptStatus[]
}

export interface SlotThresholdConceptValidatorOptions {
  thresholds?: ConceptValidationThresholds
}

export class SlotThresholdConceptValidator implements ConceptValidator {
  private readonly defaults: ConceptValidationThresholds

  constructor(options: SlotThresholdConceptValidatorOptions = {}) {
    this.defaults = options.thresholds ?? {}
  }

  async validate(request: ConceptValidationRequest): Promise<ConceptValidationResult> {
    const now = new Date().toISOString()
    const thresholds = mergeThresholds(
      this.defaults,
      parseThresholds(request.hypothesis.validation_slot),
      parseThresholds(request.validation_slots),
    )

    const reasons: string[] = []
    let hardRejected = false

    const rejectedStatuses = new Set(thresholds.rejected_statuses ?? ["deprecated"])
    if (rejectedStatuses.has(request.hypothesis.status)) {
      reasons.push(`status ${request.hypothesis.status} is not eligible for validation`)
      hardRejected = true
    }

    const promotableStatuses = new Set(thresholds.promotable_statuses ?? ["draft", "validated"])
    if (!promotableStatuses.has(request.hypothesis.status)) {
      reasons.push(`status ${request.hypothesis.status} is not promotable`)
    }

    const evidenceCount = request.evidence_refs.length
    const minEvidenceRefs = thresholds.min_evidence_refs ?? 1
    if (evidenceCount < minEvidenceRefs) {
      reasons.push(`evidence refs ${evidenceCount} below required minimum ${minEvidenceRefs}`)
    }

    for (const [path, minimum] of Object.entries(thresholds.required_numeric_slots ?? {})) {
      const actual = numericValueAtPath(request.validation_slots, path)
      if (actual == null) {
        reasons.push(`missing numeric slot ${path}`)
        continue
      }
      if (actual < minimum) {
        reasons.push(`numeric slot ${path}=${actual} below minimum ${minimum}`)
      }
    }

    for (const [path, maximum] of Object.entries(thresholds.maximum_numeric_slots ?? {})) {
      const actual = numericValueAtPath(request.validation_slots, path)
      if (actual == null) {
        reasons.push(`missing numeric slot ${path}`)
        continue
      }
      if (actual > maximum) {
        reasons.push(`numeric slot ${path}=${actual} above maximum ${maximum}`)
      }
    }

    for (const path of thresholds.required_truthy_slots ?? []) {
      const actual = truthyValueAtPath(request.validation_slots, path)
      if (!actual) {
        reasons.push(`required truthy slot ${path} is not satisfied`)
      }
    }

    const promoted = !hardRejected && reasons.length === 0
    const result = hardRejected ? "rejected" : promoted ? "validated" : "hold"

    return {
      run: {
        validation_run_id: buildValidationRunId(request.hypothesis.concept_id, now),
        concept_id: request.hypothesis.concept_id,
        input_refs: [...request.evidence_refs],
        result,
        summary_slots: {
          evaluated_at: now,
          evidence_ref_count: evidenceCount,
          min_evidence_refs: minEvidenceRefs,
          promotable_statuses: [...promotableStatuses],
          rejected_statuses: [...rejectedStatuses],
          evaluated_validation_slots: request.validation_slots ?? null,
          failure_count: reasons.length,
        },
        created_at: now,
      },
      promoted,
      reasons,
    }
  }
}

function mergeThresholds(
  ...items: Array<ConceptValidationThresholds | null | undefined>
): ConceptValidationThresholds {
  const merged: ConceptValidationThresholds = {}

  for (const item of items) {
    if (!item) {
      continue
    }
    if (item.min_evidence_refs != null) {
      merged.min_evidence_refs = item.min_evidence_refs
    }
    if (item.required_numeric_slots) {
      merged.required_numeric_slots = {
        ...(merged.required_numeric_slots ?? {}),
        ...item.required_numeric_slots,
      }
    }
    if (item.maximum_numeric_slots) {
      merged.maximum_numeric_slots = {
        ...(merged.maximum_numeric_slots ?? {}),
        ...item.maximum_numeric_slots,
      }
    }
    if (item.required_truthy_slots) {
      merged.required_truthy_slots = [...item.required_truthy_slots]
    }
    if (item.promotable_statuses) {
      merged.promotable_statuses = [...item.promotable_statuses]
    }
    if (item.rejected_statuses) {
      merged.rejected_statuses = [...item.rejected_statuses]
    }
  }

  return merged
}

function parseThresholds(slot: SlotValue | undefined): ConceptValidationThresholds | undefined {
  if (!slot) {
    return undefined
  }

  return {
    min_evidence_refs: numericFromObject(slot.min_evidence_refs),
    required_numeric_slots: recordOfNumbers(slot.required_numeric_slots),
    maximum_numeric_slots: recordOfNumbers(slot.maximum_numeric_slots),
    required_truthy_slots: arrayOfStrings(slot.required_truthy_slots),
    promotable_statuses: arrayOfConceptStatuses(slot.promotable_statuses),
    rejected_statuses: arrayOfConceptStatuses(slot.rejected_statuses),
  }
}

function buildValidationRunId(conceptId: string, createdAt: string): string {
  const safeConceptId = conceptId.replace(/[^a-zA-Z0-9_-]+/g, "_")
  const safeTimestamp = createdAt.replace(/[:.]/g, "-")
  return `validation:${safeConceptId}:${safeTimestamp}`
}

function numericValueAtPath(slot: SlotValue | undefined, path: string): number | null {
  const value = valueAtPath(slot, path)
  if (typeof value === "number") {
    return value
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0
  }
  return null
}

function truthyValueAtPath(slot: SlotValue | undefined, path: string): boolean {
  const value = valueAtPath(slot, path)
  if (typeof value === "boolean") {
    return value
  }
  if (typeof value === "number") {
    return value !== 0
  }
  if (typeof value === "string") {
    return value.length > 0
  }
  return false
}

function valueAtPath(slot: SlotValue | undefined, path: string): JsonValue | undefined {
  if (!slot) {
    return undefined
  }
  const parts = path.split(".").filter(Boolean)
  let current: JsonValue | undefined = slot
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined
    }
    current = current[part]
  }
  return current
}

function numericFromObject(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined
}

function recordOfNumbers(value: JsonValue | undefined): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }

  const result: Record<string, number> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number") {
      result[key] = item
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function arrayOfStrings(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const result = value.filter((item): item is string => typeof item === "string")
  return result.length > 0 ? result : undefined
}

function arrayOfConceptStatuses(value: JsonValue | undefined): MlConceptStatus[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const result = value.filter(
    (item): item is MlConceptStatus =>
      item === "draft" || item === "validated" || item === "deprecated",
  )
  return result.length > 0 ? result : undefined
}
