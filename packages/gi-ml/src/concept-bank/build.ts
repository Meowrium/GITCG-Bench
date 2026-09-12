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
  MlCompatibilityInfo,
  MlConceptBank,
  MlConceptHypothesis,
  MlConceptStatus,
  SlotValue,
} from "../contracts/index.js"

export interface BuildConceptBankOptions {
  bankVersion: string
  createdAt?: string
  compatibility?: MlCompatibilityInfo | null
  validationSummary?: SlotValue
  metadata?: SlotValue
  includeStatuses?: readonly MlConceptStatus[]
}

export function buildConceptBank(
  concepts: readonly MlConceptHypothesis[],
  options: BuildConceptBankOptions,
): MlConceptBank {
  const allowedStatuses = new Set(options.includeStatuses ?? ["draft", "validated"])
  const deduped = dedupeConcepts(
    concepts.filter((concept) => allowedStatuses.has(concept.status)),
  )

  return {
    bank_version: options.bankVersion,
    created_at: options.createdAt ?? new Date().toISOString(),
    compatibility: options.compatibility ?? null,
    concepts: deduped.sort((left, right) => left.concept_id.localeCompare(right.concept_id)),
    validation_summary: options.validationSummary ?? null,
    deprecation_rules: [],
    metadata: options.metadata ?? null,
  }
}

function dedupeConcepts(
  concepts: readonly MlConceptHypothesis[],
): MlConceptHypothesis[] {
  const bestById = new Map<string, MlConceptHypothesis>()

  for (const concept of concepts) {
    const previous = bestById.get(concept.concept_id)
    if (!previous) {
      bestById.set(concept.concept_id, concept)
      continue
    }
    if (compareConceptFreshness(concept, previous) >= 0) {
      bestById.set(concept.concept_id, concept)
    }
  }

  return [...bestById.values()]
}

function compareConceptFreshness(
  left: MlConceptHypothesis,
  right: MlConceptHypothesis,
): number {
  const leftUpdated = Date.parse(left.updated_at ?? left.created_at ?? "")
  const rightUpdated = Date.parse(right.updated_at ?? right.created_at ?? "")
  if (Number.isFinite(leftUpdated) && Number.isFinite(rightUpdated) && leftUpdated !== rightUpdated) {
    return leftUpdated - rightUpdated
  }
  return left.status.localeCompare(right.status)
}
