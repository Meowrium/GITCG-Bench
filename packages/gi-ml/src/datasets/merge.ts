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

import type { JsonValue, MlRankingDataset, MlRankingQueryGroup, SlotValue } from "../contracts/index.js"

export interface MergeRankingDatasetsOptions {
  datasetId?: string
}

export function mergeRankingDatasets(
  datasets: readonly MlRankingDataset[],
  options: MergeRankingDatasetsOptions = {},
): MlRankingDataset {
  const queryGroups = datasets.flatMap((dataset) => dataset.query_groups)
  const deduped = dedupeQueryGroups(queryGroups)

  return {
    dataset_id: options.datasetId ?? buildMergedDatasetId(datasets),
    created_at: new Date().toISOString(),
    metadata: {
      source: "merged_ranking_datasets",
      source_dataset_ids: datasets.map((dataset) => dataset.dataset_id),
      source_dataset_count: datasets.length,
      query_group_count: deduped.length,
    },
    query_groups: deduped,
  }
}

function dedupeQueryGroups(groups: readonly MlRankingQueryGroup[]): MlRankingQueryGroup[] {
  const byId = new Map<string, MlRankingQueryGroup>()

  for (const group of groups) {
    const previous = byId.get(group.query_id)
    if (!previous) {
      byId.set(group.query_id, cloneGroup(group))
      continue
    }
    byId.set(group.query_id, mergeQueryGroup(previous, group))
  }

  return [...byId.values()].sort((left, right) => left.query_id.localeCompare(right.query_id))
}

function cloneGroup(group: MlRankingQueryGroup): MlRankingQueryGroup {
  return {
    ...group,
    context_slots: group.context_slots ? structuredClone(group.context_slots) : null,
    candidates: group.candidates.map((candidate) => ({
      ...candidate,
      runtime_slots: candidate.runtime_slots ? structuredClone(candidate.runtime_slots) : null,
    })),
    pairwise_preferences: group.pairwise_preferences
      ? group.pairwise_preferences.map((preference) => ({
          ...preference,
          preference_slots: preference.preference_slots
            ? structuredClone(preference.preference_slots)
            : null,
        }))
      : [],
  }
}

function mergeQueryGroup(
  left: MlRankingQueryGroup,
  right: MlRankingQueryGroup,
): MlRankingQueryGroup {
  const candidates = new Map(
    [...left.candidates, ...right.candidates].map((candidate) => [candidate.candidate_id, candidate]),
  )
  const preferences = new Map<string, NonNullable<MlRankingQueryGroup["pairwise_preferences"]>[number]>()

  for (const preference of [...(left.pairwise_preferences ?? []), ...(right.pairwise_preferences ?? [])]) {
    const key = [
      preference.query_id,
      preference.candidate_a_id,
      preference.candidate_b_id,
      preference.preference_label,
      preference.evidence_ref ?? "",
    ].join("::")
    preferences.set(key, preference)
  }

  return {
    query_id: left.query_id,
    source: left.source ?? right.source ?? null,
    state_ref: left.state_ref ?? right.state_ref ?? null,
    context_slots: mergeSlotValues(left.context_slots, right.context_slots),
    candidates: [...candidates.values()].sort((a, b) => a.candidate_id.localeCompare(b.candidate_id)),
    pairwise_preferences: [...preferences.values()],
  }
}

function mergeSlotValues(left: SlotValue | undefined, right: SlotValue | undefined): SlotValue {
  if (!left && !right) {
    return null
  }
  const result: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(left ?? {})) {
    result[key] = value
  }
  for (const [key, value] of Object.entries(right ?? {})) {
    const previous = result[key]
    if (
      previous &&
      value &&
      typeof previous === "object" &&
      typeof value === "object" &&
      !Array.isArray(previous) &&
      !Array.isArray(value)
    ) {
      result[key] = mergeSlotValues(
        previous as Record<string, JsonValue>,
        value as Record<string, JsonValue>,
      ) as JsonValue
      continue
    }
    result[key] = value
  }
  return result
}

function buildMergedDatasetId(datasets: readonly MlRankingDataset[]): string {
  if (datasets.length === 0) {
    return "merged_dataset_empty"
  }
  return `merged__${datasets.map((dataset) => dataset.dataset_id).join("__")}`
}
