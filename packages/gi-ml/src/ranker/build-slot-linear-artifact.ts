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

import type { MlCandidateAction, MlRankingDataset } from "../contracts/index.js"
import type { SlotLinearRankerArtifact, SlotLinearWeightMap } from "./artifact.js"

export interface BuildSlotLinearArtifactOptions {
  artifactVersion?: string
  includeActionCaseBias?: boolean
  includeCandidateTagBias?: boolean
  includeCandidateNumericSlotWeights?: boolean
  topTagCount?: number
  topCandidateNumericSlotCount?: number
}

export function buildSlotLinearArtifactFromDataset(
  dataset: MlRankingDataset,
  options: BuildSlotLinearArtifactOptions = {},
): SlotLinearRankerArtifact {
  const actionCaseBias = options.includeActionCaseBias === false
    ? {}
    : computeActionCaseBias(dataset)
  const candidateTagBias = options.includeCandidateTagBias === false
    ? {}
    : computeCandidateTagBias(dataset, options.topTagCount ?? 32)
  const candidateNumericSlotWeights = options.includeCandidateNumericSlotWeights === false
    ? {}
    : computeCandidateNumericSlotWeights(dataset, options.topCandidateNumericSlotCount ?? 24)

  return {
    artifact_type: "slot_linear_ranker.v1",
    artifact_version: options.artifactVersion ?? `dataset_${dataset.dataset_id}`,
    created_at: new Date().toISOString(),
    compatibility: null,
    config: {
      action_case_bias: actionCaseBias,
      candidate_tag_bias: candidateTagBias,
      candidate_numeric_slot_weights: candidateNumericSlotWeights,
      metadata: {
        dataset_id: dataset.dataset_id,
        query_count: dataset.query_groups.length,
      },
    },
  }
}

function computeActionCaseBias(dataset: MlRankingDataset): SlotLinearWeightMap {
  const stats = new Map<string, { total: number; count: number }>()
  for (const group of dataset.query_groups) {
    const candidateScores = scoreCandidatesInGroup(group.candidates, group.pairwise_preferences ?? [])
    for (const candidate of group.candidates) {
      const score = candidateScores.get(candidate.candidate_id) ?? 0
      const entry = stats.get(candidate.action_case) ?? { total: 0, count: 0 }
      entry.total += score
      entry.count += 1
      stats.set(candidate.action_case, entry)
    }
  }
  return averageMap(stats)
}

function computeCandidateTagBias(
  dataset: MlRankingDataset,
  topTagCount: number,
): SlotLinearWeightMap {
  const stats = new Map<string, { total: number; count: number }>()
  for (const group of dataset.query_groups) {
    const candidateScores = scoreCandidatesInGroup(group.candidates, group.pairwise_preferences ?? [])
    for (const candidate of group.candidates) {
      const score = candidateScores.get(candidate.candidate_id) ?? 0
      const tags = extractCandidateTags(candidate)
      for (const tag of tags) {
        const entry = stats.get(tag) ?? { total: 0, count: 0 }
        entry.total += score
        entry.count += 1
        stats.set(tag, entry)
      }
    }
  }

  return [...stats.entries()]
    .map(([key, value]) => ({
      key,
      avg: value.count > 0 ? value.total / value.count : 0,
      count: value.count,
    }))
    .sort((left, right) => {
      const absDiff = Math.abs(right.avg) - Math.abs(left.avg)
      if (absDiff !== 0) {
        return absDiff
      }
      return right.count - left.count
    })
    .slice(0, Math.max(0, topTagCount))
    .reduce<SlotLinearWeightMap>((acc, item) => {
      acc[item.key] = item.avg
      return acc
    }, {})
}

function computeCandidateNumericSlotWeights(
  dataset: MlRankingDataset,
  topSlotCount: number,
): SlotLinearWeightMap {
  const stats = new Map<string, NumericWeightStats>()

  for (const group of dataset.query_groups) {
    const candidateScores = scoreCandidatesInGroup(group.candidates, group.pairwise_preferences ?? [])
    for (const candidate of group.candidates) {
      const score = candidateScores.get(candidate.candidate_id) ?? 0
      const numericSlots = extractCandidateNumericSlots(candidate)
      for (const [path, value] of Object.entries(numericSlots)) {
        updateNumericWeightStats(stats, `candidate_numeric_slots.${path}`, value, score)
      }
    }
  }

  return finalizeNumericWeightMap(stats, topSlotCount)
}

function averageMap(
  stats: Map<string, { total: number; count: number }>,
): SlotLinearWeightMap {
  const result: SlotLinearWeightMap = {}
  for (const [key, value] of stats) {
    result[key] = value.count > 0 ? value.total / value.count : 0
  }
  return result
}

function scoreCandidatesInGroup(
  candidates: readonly MlCandidateAction[],
  preferences: readonly {
    candidate_a_id: string
    candidate_b_id: string
    preference_label: number
    confidence?: number | null
  }[],
): Map<string, number> {
  if (preferences.length === 0) {
    return scoreCandidatesFromContinuation(candidates)
  }

  const scores = new Map<string, number>(
    candidates.map((candidate) => [candidate.candidate_id, 0]),
  )
  for (const preference of preferences) {
    const confidence = preference.confidence ?? 1
    if (preference.preference_label > 0) {
      scores.set(
        preference.candidate_a_id,
        (scores.get(preference.candidate_a_id) ?? 0) + confidence,
      )
      scores.set(
        preference.candidate_b_id,
        (scores.get(preference.candidate_b_id) ?? 0) - confidence,
      )
      continue
    }
    if (preference.preference_label < 0) {
      scores.set(
        preference.candidate_a_id,
        (scores.get(preference.candidate_a_id) ?? 0) - confidence,
      )
      scores.set(
        preference.candidate_b_id,
        (scores.get(preference.candidate_b_id) ?? 0) + confidence,
      )
    }
  }
  return scores
}

function extractCandidateTags(candidate: MlCandidateAction): string[] {
  const raw = candidate.runtime_slots?.candidate_tags
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string")
    : []
}

interface NumericWeightStats {
  count: number
  sumValue: number
  sumScore: number
  sumValueSq: number
  sumValueScore: number
}

function extractCandidateNumericSlots(candidate: MlCandidateAction): Record<string, number> {
  const raw = candidate.runtime_slots?.candidate_numeric_slots
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {}
  }
  return flattenNumericSlotRecord(raw as Record<string, unknown>)
}

function flattenNumericSlotRecord(
  value: Record<string, unknown>,
  prefix = "",
): Record<string, number> {
  const result: Record<string, number> = {}
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof child === "number" && Number.isFinite(child)) {
      result[path] = child
      continue
    }
    if (typeof child === "boolean") {
      result[path] = child ? 1 : 0
      continue
    }
    if (child && typeof child === "object" && !Array.isArray(child)) {
      Object.assign(result, flattenNumericSlotRecord(child as Record<string, unknown>, path))
    }
  }
  return result
}

function updateNumericWeightStats(
  stats: Map<string, NumericWeightStats>,
  path: string,
  value: number,
  score: number,
) {
  const entry = stats.get(path) ?? {
    count: 0,
    sumValue: 0,
    sumScore: 0,
    sumValueSq: 0,
    sumValueScore: 0,
  }
  entry.count += 1
  entry.sumValue += value
  entry.sumScore += score
  entry.sumValueSq += value * value
  entry.sumValueScore += value * score
  stats.set(path, entry)
}

function finalizeNumericWeightMap(
  stats: Map<string, NumericWeightStats>,
  topSlotCount: number,
): SlotLinearWeightMap {
  return [...stats.entries()]
    .map(([path, stat]) => {
      const meanValue = stat.sumValue / stat.count
      const meanScore = stat.sumScore / stat.count
      const variance = stat.sumValueSq / stat.count - meanValue * meanValue
      if (variance <= 0) {
        return null
      }
      const covariance = stat.sumValueScore / stat.count - meanValue * meanScore
      const weight = covariance / variance
      if (!Number.isFinite(weight) || weight === 0) {
        return null
      }
      return {
        path,
        weight,
        count: stat.count,
      }
    })
    .filter((item): item is { path: string; weight: number; count: number } => item != null)
    .sort((left, right) => {
      const absDiff = Math.abs(right.weight) - Math.abs(left.weight)
      if (absDiff !== 0) {
        return absDiff
      }
      return right.count - left.count
    })
    .slice(0, Math.max(0, topSlotCount))
    .reduce<SlotLinearWeightMap>((acc, item) => {
      acc[item.path] = item.weight
      return acc
    }, {})
}

function scoreCandidatesFromContinuation(
  candidates: readonly MlCandidateAction[],
): Map<string, number> {
  const values = candidates.map((candidate) => ({
    candidate_id: candidate.candidate_id,
    score: extractContinuationScore(candidate),
  }))
  const mean = values.length > 0
    ? values.reduce((acc, item) => acc + item.score, 0) / values.length
    : 0

  return new Map(
    values.map((item) => [item.candidate_id, item.score - mean]),
  )
}

function extractContinuationScore(candidate: MlCandidateAction): number {
  const runtime = candidate.runtime_slots
  if (!runtime || typeof runtime !== "object") {
    return 0
  }

  const continuation = (runtime as Record<string, unknown>).continuation
  if (!continuation || typeof continuation !== "object") {
    return 0
  }

  const continuationRecord = continuation as Record<string, unknown>
  const explicitScore = continuationRecord.score
  if (typeof explicitScore === "number" && Number.isFinite(explicitScore)) {
    return explicitScore
  }

  const wins = asNumber(continuationRecord.wins)
  const losses = asNumber(continuationRecord.losses)
  const draws = asNumber(continuationRecord.draws)
  const total = wins + losses + draws
  if (total > 0) {
    return (wins + draws * 0.5) / total
  }

  return asNumber(continuationRecord.win_rate)
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}
